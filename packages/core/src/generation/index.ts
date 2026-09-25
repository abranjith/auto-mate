// Generation barrel (FEAT-106). Pure, browser-safe logic only: no Node
// built-ins, no I/O, and no route from here to an upload's stored bytes.
export {
  MAX_GENERATION_ATTEMPTS,
  GENERATION_TIMEOUT_MS,
  TEST_RUN_TIMEOUT_MS,
  UV_SYNC_TIMEOUT_MS,
  MAX_GENERATION_COST_USD,
  MAX_SCRIPT_BYTES,
  FIXTURE_ROW_COUNT,
  MAX_GUIDANCE_CHARS,
  MAX_CODE_PATH_CHARS,
  MAX_CODE_PATH_DEPTH,
  FIXTURE_PREVIEW_ROWS,
} from './limits';
export { sha256Hex } from './sha256';
export { CODE_VERSION_STATUSES, CODE_FILE_ROLES, computeVersionDigest, countLines, shortDigest } from './code-version';
export type { CodeVersionStatus, CodeFileRole, DigestInput } from './code-version';
export { validateCodePath } from './code-path';
export { describeAttempt, summarizeAttempts } from './attempt';
export type { AttemptSummaryInput, AttemptSummaryOptions } from './attempt';
export { buildSyntheticFixture } from './synthetic-fixture';
export type { SyntheticColumn, SyntheticSource, SyntheticTable, SyntheticOptions } from './synthetic-fixture';
export { renderCodeContract, MANIFEST_FILENAME, SYNTHETIC_DATA_WARNING } from './code-contract';
export type { CodeContractContext, ContractInputFile } from './code-contract';
