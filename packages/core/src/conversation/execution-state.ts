import { ERROR_CODES } from '../errors/error-codes';
import { ValidationError } from '../errors/index';

/** Every persisted execution state. Later features activate the parked states. */
export const EXECUTION_STATUSES = [
  'pending',
  'generating',
  'verifying',
  'executing',
  'waiting',
  'completed',
  'failed',
  'aborted',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const TERMINAL_STATUSES = [
  'completed',
  'failed',
  'aborted',
] as const satisfies readonly ExecutionStatus[];

/** Explicit transition graph; terminal and future-state rows are deliberately empty. */
export const TRANSITIONS: Readonly<
  Record<ExecutionStatus, readonly ExecutionStatus[]>
> = {
  pending: ['generating', 'failed', 'aborted'],
  generating: ['completed', 'failed', 'aborted'],
  verifying: [], // FEAT-107
  executing: [], // FEAT-108
  waiting: [], // FEAT-105
  completed: [],
  failed: [],
  aborted: [],
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
