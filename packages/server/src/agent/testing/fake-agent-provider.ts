/**
 * An in-memory double for the agent seam (FEAT-102 TASK-008).
 *
 * It ships in `src`, not `__tests__`, because FEAT-103, FEAT-106, and FEAT-107
 * tests depend on it. It is typed against the real `AgentProvider` and
 * `AgentSession` interfaces, so a change to the seam breaks its build — which
 * is exactly the point. A contract test runs the same assertions against this
 * double and the stub-backed `PiSession`, so the two cannot drift.
 */

import { Value } from '@sinclair/typebox/value';
import type {
  AgentAuthSource,
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionOptions,
  AgentToolDefinition,
} from '@automate/core';

/**
 * One scripted step (FEAT-106): emit an event, or call a registered tool the
 * way the Pi adapter does — `tool_started`, `execute()`, then `tool_finished`
 * with the JSON-encoded result, or an error result when `execute` throws or
 * the arguments fail the tool's parameter schema.
 */
export type FakeAgentStep =
  | { readonly event: AgentEvent }
  | { readonly call: { readonly tool: string; readonly args: unknown; readonly callId?: string } }
  | { readonly until: Promise<void> };

/** A tool call the fake made, and what came back. */
export interface FakeToolResult {
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly output: unknown;
  readonly isError: boolean;
}

/** One scripted run: the events to emit, then the result to return. */
export interface FakeAgentScript {
  /** Events emitted, in order, during the run. */
  readonly events: readonly AgentEvent[];
  /** Steps run in order after `events`, awaiting each tool call. Stops early once aborted. */
  readonly steps?: readonly FakeAgentStep[];
  /** The terminal result the run resolves with. */
  readonly result: AgentRunResult;
  /** Optional gate keeping the fake run live until a test releases it. */
  readonly waitUntil?: Promise<void>;
}

/** The result used when a run has no script left. */
const IDLE_RESULT: AgentRunResult = {
  outcome: 'completed',
  stopReason: 'stop',
  usage: { turns: 0 },
};

/** An in-memory `AgentSession` driven by a list of scripted runs. */
export class FakeAgentSession implements AgentSession {
  /** Every prompt this session was asked to run, in order. */
  readonly prompts: string[] = [];
  /** How many times `abort()` was called. */
  abortCount = 0;
  /** How many times `close()` did its work; repeat closes do not increment it. */
  closeCount = 0;

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private runIndex = 0;
  private closed = false;
  private aborted = false;
  private resolveAbort!: () => void;
  private readonly abortSignal = new Promise<void>((resolve) => {
    this.resolveAbort = resolve;
  });

  /** Every tool call a scripted step made, in order, with its result. */
  readonly toolResults: FakeToolResult[] = [];

  /** @param id Session identity. @param logPath Reported log path. @param authSource Reported credential origin. @param script One entry per expected run. @param tools Tools registered for this session, callable by scripted steps. @param executionId Passed to each tool's `execute` context. @example new FakeAgentSession('s1', '/tmp/s1.jsonl', 'managed', [{ events, result }]) */
  constructor(
    readonly id: string,
    readonly logPath: string,
    readonly authSource: AgentAuthSource,
    private readonly script: readonly FakeAgentScript[] = [],
    private readonly tools: readonly AgentToolDefinition[] = [],
    private readonly executionId = '0',
  ) {}

  /** Run scripted steps in order, stopping at the first one reached after an abort. */
  private async runSteps(steps: readonly FakeAgentStep[]): Promise<void> {
    for (const [index, step] of steps.entries()) {
      if (this.aborted) return;
      if ('event' in step) this.dispatch(step.event);
      else if ('until' in step) await Promise.race([step.until, this.abortSignal]);
      else await this.callTool(step.call.tool, step.call.args, step.call.callId ?? `fake-call-${this.runIndex}-${index + 1}`);
    }
  }

  /** Call one registered tool exactly as the Pi adapter bridges it. */
  private async callTool(name: string, args: unknown, callId: string): Promise<void> {
    const at = () => new Date().toISOString();
    this.dispatch({ type: 'tool_started', callId, tool: name, input: args, at: at() });
    const tool = this.tools.find((candidate) => candidate.name === name);
    let output: unknown;
    let isError = false;
    try {
      if (!tool) throw new Error(`Tool ${name} is not registered for this session.`);
      if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}: ${[...Value.Errors(tool.parameters, args)].map((error) => `${error.path || '/'} ${error.message}`).join('; ')}`);
      const result = await tool.execute(args as never, { executionId: this.executionId, callId });
      output = { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } catch (cause) {
      isError = true;
      output = { content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }], details: {} };
    }
    this.toolResults.push({ callId, tool: name, args, output, isError });
    this.dispatch({ type: 'tool_finished', callId, tool: name, output, isError, at: at() });
  }

  /** Emit the next scripted batch and return its result. @param prompt The prompt text, recorded for assertions. @returns The scripted terminal result, or an aborted one after `abort()`. @throws Error when the session is closed, matching the real session's misuse behavior. @example await fake.run('go') */
  async run(prompt: string): Promise<AgentRunResult> {
    if (this.closed) throw new Error('run() was called on a closed session');
    this.prompts.push(prompt);
    const scripted = this.script[this.runIndex];
    this.runIndex += 1;
    for (const event of scripted?.events ?? []) this.dispatch(event);
    await this.runSteps(scripted?.steps ?? []);
    if (scripted?.waitUntil)
      await Promise.race([scripted.waitUntil, this.abortSignal]);
    if (this.aborted)
      return {
        outcome: 'aborted',
        stopReason: 'aborted',
        usage: scripted?.result.usage ?? { turns: 0 },
      };
    return scripted?.result ?? IDLE_RESULT;
  }

  /** Subscribe to scripted events. @param listener Receives every emitted event. @returns The unsubscribe function. @example const off = fake.subscribe(collect) */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Record an abort. @returns Nothing; idempotent counting matches the real session. @example await fake.abort() */
  abort(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.abortCount += 1;
    this.aborted = true;
    this.resolveAbort();
    return Promise.resolve();
  }

  /** Emit one normalized event while a deferred run is live. */
  emit(event: AgentEvent): void {
    this.dispatch(event);
  }

  /** Record a close. @returns Nothing; a second close is a no-op. @example await fake.close() */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.closeCount += 1;
    this.listeners.clear();
    return Promise.resolve();
  }

  /** Deliver one event, keeping the real session's promise that a throwing listener does not starve the others. */
  private dispatch(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a throwing consumer must not break the loop, exactly as in PiSession */
      }
    }
  }
}

/** An in-memory `AgentProvider` handing out {@link FakeAgentSession}s. */
export class FakeAgentProvider implements AgentProvider {
  /** Every `open()` call's options, in order. */
  readonly opened: AgentSessionOptions[] = [];
  /** Every session handed out, in order. */
  readonly sessions: FakeAgentSession[] = [];

  /** @param script The runs every session it opens will replay. @param failWith An error to reject `open()` with, for startup-failure tests. @example new FakeAgentProvider([{ events: [], result }]) */
  constructor(
    private readonly script: readonly FakeAgentScript[] = [],
    private readonly failWith?: Error,
  ) {}

  /** Scripts for sessions not yet opened, used once each in order before falling back to the default script. */
  private readonly queued: (readonly FakeAgentScript[])[] = [];

  /** Script the next session this provider opens, for tests that run more than one execution. @param script That session's runs. */
  enqueue(script: readonly FakeAgentScript[]): void {
    this.queued.push(script);
  }

  /** Record the options and hand back a scripted session. @param options Seam session options. @returns The fake session. @throws The configured error when one was supplied. @example await fake.open(options) */
  open(options: AgentSessionOptions): Promise<AgentSession> {
    this.opened.push(options);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const authSource: AgentAuthSource =
      options.auth.mode === 'personal-pi' ? 'personal-pi' : 'managed';
    const session = new FakeAgentSession(
      `fake-session-${this.sessions.length + 1}`,
      `${options.sessionDir}/fake-session.jsonl`,
      authSource,
      this.queued.shift() ?? this.script,
      options.customTools ?? [],
      options.executionId,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
