// Verification, approval, run, and review failures (FEAT-107). Messages are
// plain English, name the concrete change or limit, and never carry an
// absolute path, a stack, a finding message, or a cell value.
//
// A BLOCKED run is not one of these: it is a recorded outcome with a readable
// explanation and a retry path. These are for requests that cannot proceed.
import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

const APPROVAL_REASONS: Readonly<Record<'digest' | 'runtime' | 'intent', string>> = {
  digest: 'the code changed after you approved it',
  runtime: 'the Python environment changed after you approved it',
  intent: 'what the run will do changed after you approved it',
};

export class VerificationNotFoundError extends AutoMateError { constructor(executionId: number) { super(ERROR_CODES.VERIFICATION_NOT_FOUND, `Run ${executionId} has not been checked yet.`); } }
export class VerificationStaleError extends AutoMateError { constructor(readonly changes: readonly string[] = []) { super(ERROR_CODES.VERIFICATION_STALE, changes.length ? `The earlier check no longer applies because ${changes.join('; ')}. The code is being checked again.` : 'The earlier check no longer applies to this code and runtime. The code is being checked again.'); } }
export class VerificationBlockedError extends AutoMateError { constructor(summary: string) { super(ERROR_CODES.VERIFICATION_BLOCKED, summary); } }
export class ExecutionNotApprovedError extends AutoMateError { constructor(executionId: number, status?: string) { super(ERROR_CODES.EXECUTION_NOT_APPROVED, status ? `Run ${executionId} is ${status.replace('_', ' ')}, not waiting for your approval.` : `Run ${executionId} has not been approved to run. Review what it will do and choose Run it first.`); } }
export class ApprovalIntentMismatchError extends AutoMateError { constructor() { super(ERROR_CODES.APPROVAL_INTENT_MISMATCH, 'This page is out of date: what the run will do has changed since it was shown. Reload it and review again before running.'); } }
export class ApprovalStaleError extends AutoMateError { constructor(readonly reason: 'digest' | 'runtime' | 'intent') { super(ERROR_CODES.APPROVAL_STALE, `The approval no longer applies because ${APPROVAL_REASONS[reason]}. Review the run again before it can start.`); } }
export class RunNotFoundError extends AutoMateError { constructor(executionId: number) { super(ERROR_CODES.RUN_NOT_FOUND, `Run ${executionId} has not been started on your file.`); } }
export class RunOutputMissingError extends AutoMateError { constructor(message: string) { super(ERROR_CODES.RUN_OUTPUT_MISSING, message); } }
export class CheckerUnavailableError extends AutoMateError { constructor(readonly tool: string, readonly installHint: string, message?: string) { super(ERROR_CODES.CHECKER_UNAVAILABLE, message ?? `${tool} is not available, so the code checkers cannot be prepared. Install it with: ${installHint}`); } }
export class ReviewNotPendingError extends AutoMateError { constructor(executionId: number, status: string) { super(ERROR_CODES.REVIEW_NOT_PENDING, `Run ${executionId} is ${status.replace('_', ' ')}, so there is no result waiting for your review.`); } }
export class InputCopyMismatchError extends AutoMateError { constructor(position: number) { super(ERROR_CODES.INPUT_COPY_MISMATCH, `The copy of file ${position} made for this run does not match the file you uploaded, so the run was stopped before the script started. Upload the file again and start a new run.`); } }
