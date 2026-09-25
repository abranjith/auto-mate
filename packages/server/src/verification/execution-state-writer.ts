// Moves an execution between FEAT-107's states and records the move in the
// transcript, through the registry's persist-then-broadcast path, so replay
// and live delivery cannot diverge. Every verification, approval, run, and
// review state change goes through here.

import { applyTransition, isTerminal, type ExecutionStatus, type UnnumberedConversationEvent } from '@automate/core';
import type { ExecutionRepository, ExecutionRow } from '../db/repositories/execution-repository';

export type Publish = (executionId: number, event: UnnumberedConversationEvent) => void;
type Terminal = 'completed' | 'failed' | 'aborted' | 'rejected';

/** The one place FEAT-107 services change an execution's status. */
export class ExecutionStateWriter {
  constructor(private readonly executions: ExecutionRepository, private readonly publish: Publish, private readonly clock: () => Date = () => new Date()) {}

  /** Record a status change that already happened (for example inside a repository transaction). */
  announce(executionId: number, from: ExecutionStatus, to: ExecutionStatus): void {
    if (from === to) return;
    this.publish(executionId, { type: 'state_changed', from, to, at: this.clock().toISOString() });
  }

  /** Move across a legal, non-terminal edge. @throws ValidationError for an illegal edge. */
  move(executionId: number, to: Exclude<ExecutionStatus, Terminal>): ExecutionRow {
    const from = this.current(executionId);
    if (from === to) return this.executions.getById(executionId)!;
    applyTransition(from, to);
    const row = this.executions.transitionStatus(executionId, to);
    this.announce(executionId, from, to);
    return row;
  }

  /**
   * Settle at a terminal status, with an error for `failed`.
   * @param failedEvent Also append a `failed` event — for errors, not for a blocked run, which is a recorded outcome.
   */
  settle(executionId: number, status: Terminal, error?: { readonly code: string; readonly message: string }, failedEvent = false): ExecutionRow {
    const from = this.current(executionId);
    if (isTerminal(from)) return this.executions.getById(executionId)!;
    const row = this.executions.markSettled(executionId, { status, ...(error ? { errorCode: error.code, errorMessage: error.message } : {}) });
    if (failedEvent && error) this.publish(executionId, { type: 'failed', error: { code: error.code, message: error.message }, at: this.clock().toISOString() });
    this.announce(executionId, from, status);
    return row;
  }

  current(executionId: number): ExecutionStatus {
    return this.executions.getById(executionId)!.status as ExecutionStatus;
  }
}
