// D14 defaults are provisional while the remaining operational limits are reviewed.
/** Real script wall clock: 15 minutes. `AUTOMATE_SCRIPT_RUN_TIMEOUT_MS`. */
export const SCRIPT_RUN_TIMEOUT_MS = 900_000;
/** Address space on macOS/Linux: 4 GiB; zero disables it. `AUTOMATE_SCRIPT_MEMORY_LIMIT_BYTES`. */
export const SCRIPT_MEMORY_LIMIT_BYTES = 4_294_967_296;
/** Largest output file: 512 MiB. `AUTOMATE_SCRIPT_MAX_OUTPUT_FILE_BYTES`. */
export const SCRIPT_MAX_OUTPUT_FILE_BYTES = 536_870_912;
/** All output files together: 1 GiB. `AUTOMATE_SCRIPT_MAX_OUTPUT_TOTAL_BYTES`. */
export const SCRIPT_MAX_OUTPUT_TOTAL_BYTES = 1_073_741_824;
/** Number of output files: 200. `AUTOMATE_SCRIPT_MAX_OUTPUT_FILES`. */
export const SCRIPT_MAX_OUTPUT_FILES = 200;
/** Output watchdog polling interval: 2 seconds. `AUTOMATE_OUTPUT_WATCH_INTERVAL_MS`. */
export const OUTPUT_WATCH_INTERVAL_MS = 2_000;
/** Environment preparation wall clock: 30 minutes. `AUTOMATE_RUNTIME_PREPARE_TIMEOUT_MS`. */
export const RUNTIME_PREPARE_TIMEOUT_MS = 1_800_000;
/** Interpreter download wall clock: 10 minutes. `AUTOMATE_PYTHON_INSTALL_TIMEOUT_MS`. */
export const PYTHON_INSTALL_TIMEOUT_MS = 600_000;
