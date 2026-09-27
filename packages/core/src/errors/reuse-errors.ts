import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

export class TemplateNotFoundError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.TEMPLATE_NOT_FOUND, `Saved task ${id} was not found. Open Saved tasks to choose another.`); } }
export class TemplateRevisionNotFoundError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.TEMPLATE_REVISION_NOT_FOUND, `Saved-task revision ${id} was not found. Reload this saved task.`); } }

/** A run that cannot become (or extend) a saved task. Each factory names the action to take. */
export class ExecutionNotSaveableError extends AutoMateError {
  constructor(message: string) { super(ERROR_CODES.EXECUTION_NOT_SAVEABLE, message); }
  /** @param stateLabel The run's state in `describeRunState`'s words. */
  static notAccepted(stateLabel: string): ExecutionNotSaveableError { return new ExecutionNotSaveableError(`This run is “${stateLabel}”. Only a run you accepted can be saved.`); }
  static usedSavedTask(templateName: string, revisionNumber: number): ExecutionNotSaveableError { return new ExecutionNotSaveableError(`This run already used the saved task “${templateName}” (revision ${revisionNumber}). Only a run whose code was written for it can be saved.`); }
  static notFromTemplate(): ExecutionNotSaveableError { return new ExecutionNotSaveableError('This run wasn’t made from that saved task. Save it as a new saved task instead.'); }
  static noApproval(): ExecutionNotSaveableError { return new ExecutionNotSaveableError('This run has no recorded go-ahead, so it cannot be saved. Run the task again and approve it.'); }
}
export class ExecutionAlreadySavedError extends AutoMateError { constructor(readonly templateId: number, readonly revisionNumber: number) { super(ERROR_CODES.EXECUTION_ALREADY_SAVED, `This run is already saved as revision ${revisionNumber}. Open saved task ${templateId}.`); } }
export class InputsIncompatibleError extends AutoMateError { constructor() { super(ERROR_CODES.INPUTS_INCOMPATIBLE, 'The new file does not fit this saved task. Review the fit check and choose a mapping or repair.'); } }
export class CompatibilityStaleError extends AutoMateError { constructor() { super(ERROR_CODES.COMPATIBILITY_STALE, 'The check changed since you looked. Please look again.'); } }
export class ReplayNotAvailableError extends AutoMateError { constructor(message = 'Only a run of a saved task can be run again exactly.') { super(ERROR_CODES.REPLAY_NOT_AVAILABLE, message); } }
export class RetryUsesSavedCodeError extends AutoMateError { constructor() { super(ERROR_CODES.RETRY_USES_SAVED_CODE, 'This run used a saved task’s code, so it can’t be retried by writing new code. Run it again exactly, or repair it with AI.'); } }
export class RevisionIntegrityError extends AutoMateError { constructor() { super(ERROR_CODES.REVISION_INTEGRITY, 'The saved code no longer matches its recorded digest. This run was stopped; restore the saved task from a trusted backup.'); } }
