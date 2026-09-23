/**
 * Live agent smoke check (FEAT-102 TASK-011).
 *
 * Opens a REAL session against the pinned environment, registers exactly one
 * `status` custom tool, runs one prompt that invokes it, collects the
 * normalized events, and closes. This is the live acceptance surface for the
 * provider foundation — reachable through `pnpm doctor --agent-smoke` and
 * reused behind `POST /api/agent/test-connection`.
 *
 * There is no fallback on this path: a missing credential or an unknown model
 * surfaces as a typed `AgentStartupError`, never as a silent degradation.
 */

import { Type } from '@sinclair/typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentAuthSelection, AgentAuthSource, AgentEvent, AgentModelSelection, AgentRunResult } from '@automate/core';
import type { Logger } from 'pino';
import { createPiEnvironment, type PiEnvironmentEnumeration } from './environment';
import { PiAgentProvider, type PiAgentProviderOptions } from './provider';

/** Version tag of the smoke prompt, recorded in the report so a run is reproducible. */
export const AGENT_SMOKE_PROMPT_VERSION = 'agent-smoke-v1';

const SMOKE_SYSTEM_PROMPT =
  `You are the Auto-Mate agent runtime smoke check (${AGENT_SMOKE_PROMPT_VERSION}). ` +
  'You have exactly one tool: "status". When asked to check the runtime, call the status tool once ' +
  'and then summarize its result in one short sentence. Do not use any other capability.';

const SMOKE_USER_PROMPT =
  'Check the runtime: call the status tool exactly once, then reply with one short sentence summarizing its output.';

/** Options for {@link runAgentSmoke}. */
export interface AgentSmokeOptions {
  /** Pinned Pi config root. */
  readonly piDir: string;
  /** Effective credential file. */
  readonly authPath: string;
  /** Pinned custom/local model definitions. */
  readonly modelsPath: string;
  /** Pinned staging directory for sessions not yet placed under an execution. */
  readonly sessionStagingDir: string;
  /** Directory the session JSONL is written into. */
  readonly sessionDir: string;
  /** Execution identity recorded on the session. */
  readonly executionId: string;
  /** Model to smoke against. */
  readonly model: AgentModelSelection;
  /** Credential selection; defaults to `managed`. */
  readonly auth?: AgentAuthSelection;
  /** Working directory recorded for the session; defaults to the process working directory. */
  readonly cwd?: string;
  /** Logger for session lifecycle events. */
  readonly logger: Logger;
  /** Live event callback; every event is also collected in the report. */
  readonly onEvent?: (event: AgentEvent) => void;
  /** Abort signal, so Ctrl+C aborts the in-flight run cleanly. */
  readonly signal?: AbortSignal;
  /** Test seams forwarded to the adapter and the environment. */
  readonly overrides?: Pick<PiAgentProviderOptions, 'createSession' | 'createModelRuntime' | 'mapContext'>;
}

/** The outcome of one smoke run. */
export interface AgentSmokeReport {
  /** Provider session id. */
  readonly sessionId: string;
  /** Final session JSONL location. */
  readonly logPath: string;
  /** Terminal run result. */
  readonly result: AgentRunResult;
  /** Every normalized event observed, in order. */
  readonly events: readonly AgentEvent[];
  /** True when the `status` tool completed a successful round trip. */
  readonly statusToolInvoked: boolean;
  /** Effective credential origin. */
  readonly authSource: AgentAuthSource;
  /** The pinned paths and the expected-empty ambient resource lists. */
  readonly environment: PiEnvironmentEnumeration;
  /** The system prompt version this run used. */
  readonly promptVersion: string;
}

/** The single custom tool registered for a smoke session. */
export function createStatusTool(): ToolDefinition {
  return defineTool({
    name: 'status',
    label: 'Status',
    description: 'Report the Auto-Mate runtime status (platform and Node version). Use only when asked to check the runtime.',
    // The SDK ships its own TypeBox build; the JSON Schema shape is identical,
    // so the app's shared TypeBox stays the single schema library (memory).
    parameters: Type.Object({}) as never,
    execute: () => Promise.resolve({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, platform: process.platform, node: process.versions.node }) }],
      details: { ok: true },
    }),
  }) as ToolDefinition;
}

/**
 * Run the provider smoke check: open, one tool-using prompt, clean close.
 *
 * @param options Pinned paths, the model and credential selection, and the abort signal.
 * @returns The report: session identity, events, outcome, and the isolation enumeration.
 * @throws AgentStartupError when the session cannot be opened. An absent credential is `AGENT_AUTH_UNAVAILABLE`, never a silent fallback.
 * @example await runAgentSmoke({ ...paths, executionId, model, logger })
 */
export async function runAgentSmoke(options: AgentSmokeOptions): Promise<AgentSmokeReport> {
  const cwd = options.cwd ?? process.cwd();
  const auth = options.auth ?? { mode: 'managed' as const };

  const provider = new PiAgentProvider({
    piDir: options.piDir,
    modelsPath: options.modelsPath,
    sessionStagingDir: options.sessionStagingDir,
    resolveAuthPath: () => options.authPath,
    logger: options.logger,
    customTools: [createStatusTool()],
    ...options.overrides,
  });

  const session = await provider.open({
    executionId: options.executionId,
    sessionDir: options.sessionDir,
    cwd,
    model: options.model,
    auth,
    systemPrompt: SMOKE_SYSTEM_PROMPT,
  });

  // A parallel environment build purely for the diagnostic enumeration. It
  // shares the same pinned paths as the session's own, and proves no ambient
  // resource is active.
  const environment = (await createPiEnvironment({
    piDir: options.piDir,
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    sessionStagingDir: options.sessionStagingDir,
    cwd,
    systemPrompt: SMOKE_SYSTEM_PROMPT,
    provider: options.model.provider,
    auth,
    ...(options.overrides?.createModelRuntime !== undefined ? { createModelRuntime: options.overrides.createModelRuntime } : {}),
  })).enumerate();

  const events: AgentEvent[] = [];
  const unsubscribe = session.subscribe((event) => { events.push(event); options.onEvent?.(event); });
  const onAbort = (): void => { void session.abort(); };
  const alreadyAborted = options.signal?.aborted === true;
  if (alreadyAborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // A signal that fired before the run started means never start it: sending
    // a prompt the caller has already cancelled would be a wasted provider call.
    const result: AgentRunResult = alreadyAborted
      ? { outcome: 'aborted', stopReason: 'aborted', usage: { turns: 0 } }
      : await session.run(SMOKE_USER_PROMPT);
    return {
      sessionId: session.id,
      logPath: session.logPath,
      result,
      events,
      statusToolInvoked: events.some((event) => event.type === 'tool_finished' && event.tool === 'status' && !event.isError),
      authSource: session.authSource,
      environment,
      promptVersion: AGENT_SMOKE_PROMPT_VERSION,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    unsubscribe();
    await session.close();
  }
}
