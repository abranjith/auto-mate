// Artifact limits (FEAT-109, D12/D14). Every value is PROVISIONAL against the
// remainder of open D14 and is overridable by the environment variable named
// beside it (read by the server's `getArtifactConfig`).

import { SCRIPT_MAX_OUTPUT_FILES, SCRIPT_MAX_OUTPUT_TOTAL_BYTES } from '../execution/runtime-limits';

/** Artifacts registered per run: aligned to FEAT-108's output-file watchdog cap (200), not invented beside it. `AUTOMATE_MAX_ARTIFACTS_PER_RUN`. */
export const MAX_ARTIFACTS_PER_RUN = SCRIPT_MAX_OUTPUT_FILES;
/** Head of a text/json/markdown artifact returned by the preview route: 5 MiB. `AUTOMATE_MAX_ARTIFACT_PREVIEW_BYTES`. */
export const MAX_ARTIFACT_PREVIEW_BYTES = 5_242_880;
/** Rows per table page when the client does not ask. */
export const DEFAULT_TABLE_PAGE_ROWS = 100;
/** Largest table page a client may ask for. `AUTOMATE_MAX_TABLE_PAGE_ROWS`. */
export const MAX_TABLE_PAGE_ROWS = 500;
/** Rows a table page request will stream past before reporting the cap rather than a wrong total. `AUTOMATE_MAX_TABLE_SCAN_ROWS`. */
export const MAX_TABLE_SCAN_ROWS = 50_000;
/** Rows the registrar scans for formula-prefixed cells. `AUTOMATE_FORMULA_SCAN_ROWS`. */
export const FORMULA_SCAN_ROWS = 5_000;
/** One run's archive: FEAT-108's total output cap (1 GiB). The ZIP writer separately refuses anything past 4 GiB (no Zip64). `AUTOMATE_MAX_ARCHIVE_BYTES`. */
export const MAX_ARCHIVE_BYTES = SCRIPT_MAX_OUTPUT_TOTAL_BYTES;
/** Characters kept per table cell in a preview: FEAT-104's disclosure bound, which is the right bound for a DOM too. */
export const TABLE_CELL_MAX_CHARS = 200;
