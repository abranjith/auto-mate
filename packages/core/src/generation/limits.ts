// ---------------------------------------------------------------------------
// Code-generation limits (FEAT-106, D07/D14).
//
// These are POLICY values, not performance knobs. Each was fixed by a named
// decision and every one is PROVISIONAL against the parts of D14 that remain
// open; the server reads an `AUTOMATE_*` override for each, so a different
// value is configuration and never a code change. Do not tune them to make a
// test pass or a model converge — change the decision record first.
// ---------------------------------------------------------------------------

/** D14: `run_tests` invocations per execution, counted in the database. Provisional. `AUTOMATE_MAX_GENERATION_ATTEMPTS`. */
export const MAX_GENERATION_ATTEMPTS = 3;
/** D14: wall clock across the whole `generating` phase (10 minutes). Provisional. `AUTOMATE_GENERATION_TIMEOUT_MS`. */
export const GENERATION_TIMEOUT_MS = 600_000;
/** D14: wall clock for one pytest run (2 minutes). Provisional. `AUTOMATE_TEST_RUN_TIMEOUT_MS`. */
export const TEST_RUN_TIMEOUT_MS = 120_000;
/** D14: wall clock for preparing the shared Python environment (5 minutes). Provisional. `AUTOMATE_UV_SYNC_TIMEOUT_MS`. */
export const UV_SYNC_TIMEOUT_MS = 300_000;
/**
 * D14: provider spend per execution in USD. `0` means DISABLED, deliberately:
 * a cap that is on by default would silently never fire for providers that
 * report no cost, and a limit that does not limit is worse than an absent one.
 * Provisional. `AUTOMATE_MAX_GENERATION_COST_USD`.
 */
export const MAX_GENERATION_COST_USD = 0;
/** D14: bytes of one generated file (256 KiB). Provisional. `AUTOMATE_MAX_SCRIPT_BYTES`. */
export const MAX_SCRIPT_BYTES = 262_144;
/** D04/D14: rows per synthetic fixture table, including the approved sample rows. Provisional. `AUTOMATE_FIXTURE_ROW_COUNT`. */
export const FIXTURE_ROW_COUNT = 200;
/** D07: characters of guidance a person may give a retry. */
export const MAX_GUIDANCE_CHARS = 2_000;
/** Longest accepted generated-file path, in characters. */
export const MAX_CODE_PATH_CHARS = 128;
/** Deepest accepted generated-file path, in segments (`lib/helpers.py` is 2). */
export const MAX_CODE_PATH_DEPTH = 2;
/** Fixture rows returned to the browser as a preview. */
export const FIXTURE_PREVIEW_ROWS = 20;
