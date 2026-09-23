import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

/** Raised when a requested task does not exist. */
export class TaskNotFoundError extends AutoMateError {
  constructor(id: number) {
    super(ERROR_CODES.TASK_NOT_FOUND, `Task ${id} was not found.`);
  }
}

/** Raised when a requested execution does not exist. */
export class ExecutionNotFoundError extends AutoMateError {
  constructor(id: number) {
    super(ERROR_CODES.EXECUTION_NOT_FOUND, `Execution ${id} was not found.`);
  }
}

/** Raised when a terminal execution is asked to stop. */
export class ExecutionNotRunningError extends AutoMateError {
  constructor(id: number) {
    super(
      ERROR_CODES.EXECUTION_NOT_RUNNING,
      `Execution ${id} is no longer running.`,
    );
  }
}

/** Raised when an active database row has no live in-memory session. */
export class ExecutionInterruptedError extends AutoMateError {
  constructor(id: number) {
    super(
      ERROR_CODES.EXECUTION_INTERRUPTED,
      `Execution ${id} was interrupted when the server restarted. Start it again to retry.`,
    );
  }
}

/** Raised when the configured execution concurrency limit is full. */
export class ExecutionLimitReachedError extends AutoMateError {
  constructor() {
    super(
      ERROR_CODES.EXECUTION_LIMIT_REACHED,
      'Another task is already running. Wait for it to finish, or cancel it.',
    );
  }
}
