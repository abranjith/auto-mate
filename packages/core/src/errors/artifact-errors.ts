// Artifact failures (FEAT-109). Messages are plain English, name the concrete
// limit and the next step (usually the download), and never carry an absolute
// path, a stack, a cell value, or a model-authored filename.
//
// An output that could not register is NOT one of these: it is a counted,
// rendered discrepancy on the run, never an error.
import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';
import { formatBytes } from './ingestion-errors';

export class ArtifactNotFoundError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.ARTIFACT_NOT_FOUND, `Output ${id} was not found. It may belong to a task that was deleted.`); } }
export class ArtifactFileMissingError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.ARTIFACT_FILE_MISSING, `The file for output ${id} is no longer on this computer, so it cannot be shown or downloaded. Run the task again to produce it.`); } }
export class ArtifactNotPreviewableError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.ARTIFACT_NOT_PREVIEWABLE, `Output ${id} is not a text file, so it has no text preview. Open it with its own viewer or download it.`); } }
export class ArtifactTooLargeToPreviewError extends AutoMateError { constructor(readonly limitBytes: number) { super(ERROR_CODES.ARTIFACT_TOO_LARGE_TO_PREVIEW, `This output is larger than the ${formatBytes(limitBytes)} the app will preview. Download it to open it.`); } }
export class ArtifactNotTabularError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.ARTIFACT_NOT_TABULAR, `Output ${id} is not a CSV or Excel file, so it cannot be shown as a table. Open it with its own viewer or download it.`); } }
export class ArtifactRegistrationError extends AutoMateError { constructor(reason: string) { super(ERROR_CODES.ARTIFACT_REGISTRATION_FAILED, `The run's output files could not be recorded: ${reason}. The files the script wrote are still on this computer.`); } }
export class ArchiveTooLargeError extends AutoMateError { constructor(readonly limitBytes: number) { super(ERROR_CODES.ARCHIVE_TOO_LARGE, `These outputs together are larger than the ${formatBytes(limitBytes)} a single download can hold. Download the files one at a time instead.`); } }
export class NoArtifactsError extends AutoMateError { constructor(executionId: number) { super(ERROR_CODES.ARTIFACT_NOT_FOUND, `Run ${executionId} has no output files to download.`); } }
