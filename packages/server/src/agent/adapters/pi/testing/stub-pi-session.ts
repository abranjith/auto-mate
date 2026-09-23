/**
 * A scripted stand-in for a live Pi session (FEAT-102 TASK-007/008).
 *
 * It lives inside the adapter directory because it is typed against the SDK's
 * raw event union — the one place that import is allowed. It ships beside the
 * adapter rather than in a `.test.ts` file so several suites can import it
 * without re-registering another suite's tests.
 *
 * Nothing here reaches the network.
 */

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiSessionLike } from '../provider';

/** A Pi session whose events and prompt behaviour are scripted per run. */
export class StubPiSession implements PiSessionLike {
  readonly sessionId = 'session-stub-1';
  /** Every prompt this session received, in order. */
  readonly prompts: string[] = [];
  /** How many times the adapter called `abort()`. */
  abortCount = 0;
  /** How many times the adapter called `dispose()`. */
  disposeCount = 0;

  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private scriptIndex = 0;

  /** @param script One batch of raw events per expected run. @param onPrompt Hook invoked after a batch is emitted, to reject or assert. @example new StubPiSession([[turnEndEvent]]) */
  constructor(
    private readonly script: AgentSessionEvent[][] = [],
    private readonly onPrompt?: (session: StubPiSession) => Promise<void> | void,
  ) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Emit one raw SDK event to every subscriber. @param event The raw event. @returns Nothing. @example stub.emit(rawTurnEnd) */
  emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const batch = this.script[this.scriptIndex] ?? [];
    this.scriptIndex += 1;
    for (const event of batch) this.emit(event);
    await this.onPrompt?.(this);
  }

  abort(): Promise<void> { this.abortCount += 1; return Promise.resolve(); }
  dispose(): void { this.disposeCount += 1; }
}

/** Build a raw SDK event without restating the whole union. @param event The event fields. @returns The value typed as a session event. @example rawEvent({ type: 'turn_end', message, toolResults: [] }) */
export function rawEvent(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

/** An assistant message with optional usage and terminal fields. @param fields Extra message fields. @returns The message shape the mapper reads. @example assistantMessage({ stopReason: 'error' }) */
export function assistantMessage(fields: Record<string, unknown> = {}): unknown {
  return { role: 'assistant', ...fields };
}
