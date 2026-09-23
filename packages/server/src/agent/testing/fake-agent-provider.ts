/**
 * An in-memory double for the agent seam (FEAT-102 TASK-008).
 *
 * It ships in `src`, not `__tests__`, because FEAT-103, FEAT-106, and FEAT-107
 * tests depend on it. It is typed against the real `AgentProvider` and
 * `AgentSession` interfaces, so a change to the seam breaks its build — which
 * is exactly the point. A contract test runs the same assertions against this
 * double and the stub-backed `PiSession`, so the two cannot drift.
 */

import type { AgentAuthSource, AgentEvent, AgentProvider, AgentRunResult, AgentSession, AgentSessionOptions } from '@automate/core';

/** One scripted run: the events to emit, then the result to return. */
export interface FakeAgentScript {
  /** Events emitted, in order, during the run. */
  readonly events: readonly AgentEvent[];
  /** The terminal result the run resolves with. */
  readonly result: AgentRunResult;
}

/** The result used when a run has no script left. */
const IDLE_RESULT: AgentRunResult = { outcome: 'completed', stopReason: 'stop', usage: { turns: 0 } };

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

  /** @param id Session identity. @param logPath Reported log path. @param authSource Reported credential origin. @param script One entry per expected run. @example new FakeAgentSession('s1', '/tmp/s1.jsonl', 'managed', [{ events, result }]) */
  constructor(
    readonly id: string,
    readonly logPath: string,
    readonly authSource: AgentAuthSource,
    private readonly script: readonly FakeAgentScript[] = [],
  ) {}

  /** Emit the next scripted batch and return its result. @param prompt The prompt text, recorded for assertions. @returns The scripted terminal result, or an aborted one after `abort()`. @throws Error when the session is closed, matching the real session's misuse behavior. @example await fake.run('go') */
  run(prompt: string): Promise<AgentRunResult> {
    if (this.closed) return Promise.reject(new Error('run() was called on a closed session'));
    this.prompts.push(prompt);
    const scripted = this.script[this.runIndex];
    this.runIndex += 1;
    for (const event of scripted?.events ?? []) this.dispatch(event);
    if (this.aborted) return Promise.resolve({ outcome: 'aborted', stopReason: 'aborted', usage: scripted?.result.usage ?? { turns: 0 } });
    return Promise.resolve(scripted?.result ?? IDLE_RESULT);
  }

  /** Subscribe to scripted events. @param listener Receives every emitted event. @returns The unsubscribe function. @example const off = fake.subscribe(collect) */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Record an abort. @returns Nothing; idempotent counting matches the real session. @example await fake.abort() */
  abort(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.abortCount += 1;
    this.aborted = true;
    return Promise.resolve();
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
      try { listener(event); }
      catch { /* a throwing consumer must not break the loop, exactly as in PiSession */ }
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

  /** Record the options and hand back a scripted session. @param options Seam session options. @returns The fake session. @throws The configured error when one was supplied. @example await fake.open(options) */
  open(options: AgentSessionOptions): Promise<AgentSession> {
    this.opened.push(options);
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const authSource: AgentAuthSource = options.auth.mode === 'personal-pi' ? 'personal-pi' : 'managed';
    const session = new FakeAgentSession(`fake-session-${this.sessions.length + 1}`, `${options.sessionDir}/fake-session.jsonl`, authSource, this.script);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
