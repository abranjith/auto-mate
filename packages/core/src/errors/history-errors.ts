import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';
import { describeRunState } from '../history/run-wording';
import type { ExecutionStatus } from '../conversation/execution-state';

/** A task already has a run that must be finished or cancelled first. */
export class TaskHasOpenRunError extends AutoMateError {
  /**
   * @param runId The open execution's id.
   * @param status Its current state.
   * @example new TaskHasOpenRunError(12, 'awaiting_approval')
   */
  constructor(runId: number, status: ExecutionStatus) {
    super(ERROR_CODES.TASK_HAS_OPEN_RUN, `Run ${runId} is ${describeRunState({ status }).label.toLowerCase()}. Finish or cancel it first.`);
  }
}
