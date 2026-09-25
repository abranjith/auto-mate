import { ERROR_CODES } from '../errors/error-codes';
import { ValidationError } from '../errors/index';

/** Every persisted execution state. */
export const EXECUTION_STATUSES = [
  'pending',
  'generating',
  'verifying',
  'awaiting_approval',
  'executing',
  'awaiting_review',
  'waiting',
  'completed',
  'failed',
  'aborted',
  'rejected',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'aborted',
  'rejected',
] as const satisfies readonly ExecutionStatus[];

/**
 * Executions parked on a person (FEAT-105, FEAT-107): waiting for an answer,
 * an approval, or a review. None of them holds a concurrency slot, so a run
 * sitting at a gate while its person is at lunch never blocks another task.
 */
export const PARKED_STATUSES = ['waiting', 'awaiting_approval', 'awaiting_review'] as const satisfies readonly ExecutionStatus[];

/**
 * The parked statuses that hold NO in-memory state — the gate is a database
 * row — and therefore survive a server restart untouched. `waiting` is
 * deliberately absent: its pending question lives inside a live provider
 * session, so a restart interrupts it (FEAT-105; FEAT-107 adopts this over its
 * spec's TASK-004 wording, per the TODO.md resolution recorded for FEAT-110).
 */
export const RESTART_SURVIVING_STATUSES = ['awaiting_approval', 'awaiting_review'] as const satisfies readonly ExecutionStatus[];

/**
 * Explicit transition graph; terminal rows are deliberately empty.
 * FEAT-107 filled the verifying/executing rows FEAT-103 left for it and added
 * the two gates. A later feature adds rows; it does not restructure the table.
 */
export const TRANSITIONS: Readonly<
  Record<ExecutionStatus, readonly ExecutionStatus[]>
> = {
  pending: ['generating', 'failed', 'aborted'],
  generating: ['waiting', 'verifying', 'completed', 'failed', 'aborted'],
  verifying: ['awaiting_approval', 'failed', 'aborted'],
  // The `verifying` edge is re-verification after the runtime changed.
  awaiting_approval: ['executing', 'verifying', 'aborted'],
  executing: ['awaiting_review', 'failed', 'aborted'],
  // Process exit is not acceptance: `completed` now means a person said so.
  awaiting_review: ['completed', 'rejected', 'aborted'],
  waiting: ['generating', 'failed', 'aborted'],
  completed: [],
  failed: [],
  aborted: [],
  rejected: [],
};

/** Report whether one state transition is legal. */
export function canTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Apply a legal transition or raise a stable validation error. */
export function applyTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
): ExecutionStatus {
  if (!canTransition(from, to))
    throw new ValidationError(
      `Execution cannot transition from ${from} to ${to}.`,
      { from, to },
      ERROR_CODES.INVALID_STATE_TRANSITION,
    );
  return to;
}

/** Report whether a status can never change again. */
export function isTerminal(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(
    status as (typeof TERMINAL_STATUSES)[number],
  );
}

/**
 * Whether an execution in this status holds a concurrency slot.
 *
 * @param status Any execution status.
 * @returns False for every parked status and every terminal one.
 * @example consumesConcurrencySlot('awaiting_approval') // false
 */
export function consumesConcurrencySlot(status: ExecutionStatus): boolean {
  return !isTerminal(status) && !(PARKED_STATUSES as readonly ExecutionStatus[]).includes(status);
}

/**
 * Whether an execution in this status survives a server restart untouched.
 *
 * @param status Any execution status.
 * @returns True only for `awaiting_approval` and `awaiting_review`.
 * @example survivesRestart('waiting') // false
 */
export function survivesRestart(status: ExecutionStatus): boolean {
  return (RESTART_SURVIVING_STATUSES as readonly ExecutionStatus[]).includes(status);
}
