/**
 * `PiAgentProvider` — the real Pi adapter behind the `AgentProvider` seam
 * (FEAT-102 TASK-007).
 *
 * It builds the pinned environment, resolves the model with typed failures,
 * opens a Pi session with built-in tools disabled and only the caller's custom
 * tools registered, normalizes and sanitizes the event stream, and places the
 * session log under the application data root. Everything Pi-specific stays in
 * this directory.
 *
 * The provider never degrades to a null or stub client: a startup problem is
 * always one of the typed `AgentStartupError` subclasses.
 */

import { createAgentSession, type AgentSessionEvent, type CreateAgentSessionOptions, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  AgentAuthUnavailableError, AgentModelNotFoundError, AgentSessionStartFailedError, createSanitizer,
  type AgentAuthSource, type AgentError, type AgentEvent, type AgentProvider, type AgentRunResult,
  type AgentSession, type AgentSessionOptions, type AgentUsage,
} from '@automate/core';
import type { Logger } from 'pino';
import { createPiEnvironment, type ModelRuntimeFactory, type PiEnvironment } from './environment';
import { createDefaultEventMapContext, extractTerminalState, mapPiEvent, type PiEventMapContext, type PiTerminalState } from './event-map';
import { createAgentSessionFile, type AgentSessionFile } from './session-file';

/** Reasoning levels the SDK accepts. An unknown value is a typed failure, never a silent drop. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

type PiThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The exact structural surface of a Pi session this adapter consumes. Tests inject stubs satisfying this shape. */
export interface PiSessionLike {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** Factory turning SDK options into a live Pi session. The test seam that keeps every unit test off the network. */
export type PiSessionFactory = (options: CreateAgentSessionOptions) => Promise<{ readonly session: PiSessionLike }>;

/** Construction dependencies for {@link PiAgentProvider}. */
export interface PiAgentProviderOptions {
  /** Pinned Pi config root, `<dataRoot>/pi`. */
  readonly piDir: string;
  /** Pinned custom/local model definitions. */
  readonly modelsPath: string;
  /** Pinned staging directory for sessions not yet placed under an execution. */
  readonly sessionStagingDir: string;
  /** Resolve the credential file for a session's auth selection. */
  readonly resolveAuthPath: (auth: AgentSessionOptions['auth']) => string;
  /** Logger for session lifecycle events. Event payloads are never logged. */
  readonly logger: Logger;
  /** Custom tools for every session this provider opens. Pi's built-ins are always disabled. */
  readonly customTools?: readonly ToolDefinition[];
  /** Resolved secret values the server holds, so they cannot escape through a tool payload. Normally empty: Auto-Mate never reads a credential value out of the store. */
  readonly knownSecrets?: readonly string[];
  /** Home directory collapsed to `~` in sanitized payloads. */
  readonly homeDir?: string;
  /** Session factory override (tests; never the network). */
  readonly createSession?: PiSessionFactory;
  /** Model runtime factory override (tests). */
  readonly createModelRuntime?: ModelRuntimeFactory;
  /** Sanitizer and clock override for event mapping (tests). */
  readonly mapContext?: PiEventMapContext;
}

/** Validate a configured reasoning level against the SDK's own. */
function normalizeThinkingLevel(thinking: string | undefined): PiThinkingLevel | undefined {
  if (thinking === undefined) return undefined;
  const match = THINKING_LEVELS.find((level) => level === thinking);
  if (match === undefined) {
    throw new AgentSessionStartFailedError(`the configured thinking level "${thinking}" is not one of: ${THINKING_LEVELS.join(', ')}`);
  }
  return match;
}

/**
 * Name every credential source tried, for an actionable `AGENT_AUTH_UNAVAILABLE`
 * message. The store is named, never its absolute path: a user-facing message
 * must not expose the host's directory layout.
 */
function credentialSourcesTried(mode: string): string {
  const store = mode === 'personal-pi'
    ? 'the personal Pi credential file selected on the Settings page'
    : 'the managed credential store in the application data directory';
  return `${store}, and the provider's own environment variable`;
}

/** Raise a model failure naming up to eight ids the runtime actually knows. */
function modelNotFound(environment: PiEnvironment, provider: string, id: string): AgentModelNotFoundError {
  const known = environment.modelRuntime.getModels(provider).map((model) => model.id).slice(0, 8);
  const hint = known.length > 0
    ? `Known ${provider} models include: ${known.join(', ')}.`
    : `No models are registered for provider "${provider}".`;
  return new AgentModelNotFoundError(provider, id, hint);
}

/** The real Pi adapter implementing the `AgentProvider` seam. */
export class PiAgentProvider implements AgentProvider {
  private readonly createSession: PiSessionFactory;

  /** @param options Pinned paths, the credential resolver, the logger, and the optional test seams. @example new PiAgentProvider({ piDir, modelsPath, sessionStagingDir, resolveAuthPath, logger }) */
  constructor(private readonly options: PiAgentProviderOptions) {
    this.createSession = options.createSession ?? (createAgentSession as unknown as PiSessionFactory);
  }

  /** Build the per-session mapping context, scoped to that session's working directory. */
  private contextFor(cwd: string): PiEventMapContext {
    if (this.options.mapContext !== undefined) return this.options.mapContext;
    return createDefaultEventMapContext(createSanitizer({
      ...(this.options.knownSecrets !== undefined ? { knownSecrets: this.options.knownSecrets } : {}),
      ...(this.options.homeDir !== undefined ? { homeDir: this.options.homeDir } : {}),
      workspaceDir: cwd,
    }));
  }

  /** Open a fresh Pi-backed session for one execution. @param options Seam session options. @returns The live normalized session. @throws AgentAuthUnavailableError, AgentModelNotFoundError, or AgentSessionStartFailedError. @example await provider.open({ executionId, sessionDir, cwd, model, auth, systemPrompt }) */
  async open(options: AgentSessionOptions): Promise<AgentSession> {
    const mapContext = this.contextFor(options.cwd);
    const authPath = this.options.resolveAuthPath(options.auth);
    const environment = await createPiEnvironment({
      piDir: this.options.piDir,
      authPath,
      modelsPath: this.options.modelsPath,
      sessionStagingDir: this.options.sessionStagingDir,
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      provider: options.model.provider,
      auth: options.auth,
      ...(this.options.createModelRuntime !== undefined ? { createModelRuntime: this.options.createModelRuntime } : {}),
    });

    if (environment.authSource === 'unavailable') {
      throw new AgentAuthUnavailableError(
        options.model.provider,
        credentialSourcesTried(options.auth.mode),
        "Set the provider's API key environment variable, sign in with the Pi CLI so the managed store holds a credential, or point Auto-Mate at an existing personal Pi credential file on the Settings page.",
      );
    }

    const model = environment.modelRuntime.getModel(options.model.provider, options.model.id);
    if (model === undefined) throw modelNotFound(environment, options.model.provider, options.model.id);

    const thinkingLevel = normalizeThinkingLevel(options.model.thinking);
    const sessionFile = await createAgentSessionFile({ sessionDir: options.sessionDir, cwd: options.cwd });
    const customTools = [...(this.options.customTools ?? [])];

    const sessionOptions: CreateAgentSessionOptions = {
      cwd: options.cwd,
      agentDir: environment.agentDir,
      modelRuntime: environment.modelRuntime,
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      // Pi's built-in read/bash/edit/write tools are never silently available:
      // this milestone has no execution isolation boundary (D03), so the
      // allowlist is exactly the caller's own tools and nothing else.
      noTools: 'all',
      tools: customTools.map((tool) => tool.name),
      customTools,
      resourceLoader: environment.resourceLoader,
      sessionManager: sessionFile.sessionManager,
      settingsManager: environment.settingsManager,
    };

    let piSession: PiSessionLike;
    try { piSession = (await this.createSession(sessionOptions)).session; }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new AgentSessionStartFailedError(mapContext.sanitizeText(reason));
    }

    const authSource: AgentAuthSource = environment.authSource;
    this.options.logger.info(
      { executionId: options.executionId, sessionId: piSession.sessionId, provider: options.model.provider, model: options.model.id, authSource, logPath: sessionFile.logPath() },
      'agent session opened',
    );
    return new PiSession(piSession, sessionFile, mapContext, options.executionId, authSource, this.options.logger);
  }
}

/** Per-run bookkeeping fed by the internal event subscription. */
interface RunTracker {
  turns: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | undefined;
  failed: AgentError | undefined;
  terminal: PiTerminalState | undefined;
  aborted: boolean;
}

/** The stop reason reported when the provider named none. */
const DEFAULT_STOP_REASON: Record<AgentRunResult['outcome'], string> = { completed: 'stop', failed: 'error', aborted: 'aborted' };

/** Sum optional usage numbers without materializing a zero the provider never reported. */
function addOptional(current: number | undefined, extra: number | undefined): number | undefined {
  return extra === undefined ? current : (current ?? 0) + extra;
}

/** A fresh, empty run tracker. */
function newTracker(): RunTracker {
  return { turns: 0, inputTokens: undefined, outputTokens: undefined, costUsd: undefined, failed: undefined, terminal: undefined, aborted: false };
}

/** The seam's `AgentSession`, wrapping one live Pi session. */
class PiSession implements AgentSession {
  readonly id: string;
  readonly logPath: string;

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribeInternal: () => void;
  private currentRun: RunTracker | undefined;
  private closed = false;

  constructor(
    private readonly piSession: PiSessionLike,
    private readonly sessionFile: AgentSessionFile,
    private readonly ctx: PiEventMapContext,
    private readonly executionId: string,
    readonly authSource: AgentAuthSource,
    private readonly logger: Logger,
  ) {
    this.id = piSession.sessionId;
    this.logPath = sessionFile.logPath();
    this.unsubscribeInternal = piSession.subscribe((event) => this.handleRawEvent(event));
  }

  /** Run one prompt to completion. @param prompt Prompt text. @returns The aggregated terminal result. @throws Error when the session is already closed, which is caller misuse. @example await session.run('Check the runtime status.') */
  async run(prompt: string): Promise<AgentRunResult> {
    if (this.closed) throw new AgentSessionStartFailedError('run() was called on a closed session');
    const tracker = newTracker();
    this.currentRun = tracker;
    try {
      await this.piSession.prompt(prompt, { expandPromptTemplates: false });
    } catch (cause) {
      // open() already validated the model and the credential, so a rejection
      // here is a provider failure surfacing synchronously. Normalize it rather
      // than exploding in the caller's await.
      const error: AgentError = { code: 'AGENT_PROVIDER_UNAVAILABLE', message: this.ctx.sanitizeText(cause instanceof Error ? cause.message : String(cause)) };
      tracker.failed = error;
      this.dispatch({ type: 'failed', error, at: this.ctx.now() });
    } finally {
      this.currentRun = undefined;
    }
    return this.resultOf(tracker);
  }

  /** Subscribe to normalized events. @param listener Receives every post-sanitizer event. @returns The unsubscribe function for this listener. @example const off = session.subscribe(collect) */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Abort the in-flight run. @returns Nothing; idempotent and safe after close. @example await session.abort() */
  async abort(): Promise<void> {
    if (this.closed) return;
    if (this.currentRun !== undefined) this.currentRun.aborted = true;
    await this.piSession.abort();
  }

  /** Release the session and finalize its log. @returns Nothing; idempotent. @example await session.close() */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeInternal();
    this.piSession.dispose();
    await this.sessionFile.finalize();
    this.logger.info({ executionId: this.executionId, sessionId: this.id }, 'agent session closed');
  }

  /** Aggregate one run's tracker into the seam's terminal result. */
  private resultOf(tracker: RunTracker): AgentRunResult {
    const outcome: AgentRunResult['outcome'] =
      tracker.aborted || tracker.terminal?.stopReason === 'aborted' ? 'aborted'
        : tracker.failed !== undefined ? 'failed'
          : 'completed';
    const usage: AgentUsage = {
      turns: tracker.turns,
      ...(tracker.inputTokens !== undefined ? { inputTokens: tracker.inputTokens } : {}),
      ...(tracker.outputTokens !== undefined ? { outputTokens: tracker.outputTokens } : {}),
      ...(tracker.costUsd !== undefined ? { costUsd: tracker.costUsd } : {}),
    };
    return { outcome, stopReason: tracker.terminal?.stopReason ?? DEFAULT_STOP_REASON[outcome], usage };
  }

  /** Track and normalize one raw SDK event. */
  private handleRawEvent(event: AgentSessionEvent): void {
    if (event.type === 'agent_end' && !event.willRetry && this.currentRun !== undefined) {
      this.currentRun.terminal = extractTerminalState(event.messages, this.ctx);
    }
    for (const mapped of mapPiEvent(event, this.ctx)) {
      this.track(mapped);
      this.dispatch(mapped);
    }
  }

  /** Fold one normalized event into the active run's usage and failure state. */
  private track(event: AgentEvent): void {
    const run = this.currentRun;
    if (run === undefined) return;
    if (event.type === 'turn_finished') {
      run.turns += event.usage.turns;
      run.inputTokens = addOptional(run.inputTokens, event.usage.inputTokens);
      run.outputTokens = addOptional(run.outputTokens, event.usage.outputTokens);
      run.costUsd = addOptional(run.costUsd, event.usage.costUsd);
      return;
    }
    if (event.type === 'failed') run.failed = event.error;
  }

  /** Deliver one event to every listener. Only the event type is logged — payloads can carry user data. */
  private dispatch(event: AgentEvent): void {
    this.logger.debug({ executionId: this.executionId, type: event.type }, 'agent event');
    for (const listener of [...this.listeners]) {
      try { listener(event); }
      catch (cause) {
        // A throwing consumer must not break the provider loop or starve the
        // other listeners.
        this.logger.warn({ executionId: this.executionId, err: cause instanceof Error ? cause.message : String(cause) }, 'agent event listener threw');
      }
    }
  }
}
