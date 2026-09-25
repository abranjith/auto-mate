// Ingestion barrel (FEAT-104): the only module routes and startup import.
// Nothing under this directory imports the agent layer or makes a network
// call; a boundary test enforces both.
export { UploadService, presentUpload } from './upload-service';
export type { UploadServiceDependencies } from './upload-service';
export { ProfileService } from './profile-service';
export type { ProfileServiceDependencies, ProfileOutcome } from './profile-service';
export { UploadFileStore, sanitizeFilename, stripControlCharacters, MAX_SANITIZED_NAME } from './upload-file-store';
export { receiveUpload } from './upload-intake';
export type { ReceivedUpload, IntakeOptions, UploadRequest } from './upload-intake';
export { StagedUploadSweeper, SWEEP_INTERVAL_MS, INCOMING_GRACE_MS } from './staged-upload-sweeper';
export type { SweeperDependencies, SweepResult } from './staged-upload-sweeper';
export { openCsv, MAX_RECORD_CHARS } from './csv-reader';
export type { CsvTable, CsvReaderOptions } from './csv-reader';
export { openWorkbook, excelSerialToDate, isDateFormat, SHARED_STRINGS_BUDGET_SHARE } from './xlsx-reader';
export type { XlsxSheet, XlsxWorkbook, XlsxReaderOptions, WorkbookFacts } from './xlsx-reader';
