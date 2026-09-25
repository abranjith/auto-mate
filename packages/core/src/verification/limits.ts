// ---------------------------------------------------------------------------
// Verification and execution limits (FEAT-107, D07/D14).
//
// These are POLICY values, not performance knobs. Each was fixed by the D14
// resolution recorded in FEAT-107's "Decisions applied" table and every one is
// PROVISIONAL against open D14; the server reads an `AUTOMATE_*` override for
// each, so a different value is configuration and never a code change. Do not
// tune them to make a check pass or a run finish — change the decision first.
// ---------------------------------------------------------------------------

/** D14: wall clock across one whole verification pass (5 minutes). Provisional. `AUTOMATE_VERIFICATION_TIMEOUT_MS`. */
export const VERIFICATION_TIMEOUT_MS = 300_000;
/** D14: wall clock for one `ruff` run (1 minute). Provisional. `AUTOMATE_LINT_TIMEOUT_MS`. */
export const LINT_TIMEOUT_MS = 60_000;
/** D14: wall clock for one `bandit` run (2 minutes). Provisional. `AUTOMATE_SECURITY_TIMEOUT_MS`. */
export const SECURITY_TIMEOUT_MS = 120_000;
/** D14: bytes of stdout and of stderr kept from one real run (1 MiB each), head and tail. Provisional. `AUTOMATE_MAX_RUN_OUTPUT_BYTES`. */
export const MAX_RUN_OUTPUT_BYTES = 1_048_576;
/** D07: characters a person may write when rejecting a result. Provisional. `AUTOMATE_MAX_REVIEW_FEEDBACK_CHARS`. */
export const MAX_REVIEW_FEEDBACK_CHARS = 2_000;
/** Findings stored per check; the overflow is counted and stated, never silently dropped. */
export const MAX_FINDINGS_PER_CHECK = 200;
