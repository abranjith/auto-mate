# Python run limits

If a script stops because it used too much time, memory, or output, its run result names the breached limit. The output directory remains a working directory until the run settles; a stopped run does not register its contents as accepted results. You can change the provisional defaults below by setting the server environment variables before starting Auto-Mate, then run the task again. Settings shows the limits your platform enforces.

| Limit             | Variable                                 |                     Default | Platforms                                                            |
| ----------------- | ---------------------------------------- | --------------------------: | -------------------------------------------------------------------- |
| Wall clock        | `AUTOMATE_SCRIPT_RUN_TIMEOUT_MS`         |    `900000` ms (15 minutes) | Windows, macOS, Linux                                                |
| Address space     | `AUTOMATE_SCRIPT_MEMORY_LIMIT_BYTES`     |  `4294967296` bytes (4 GiB) | macOS and Linux only                                                 |
| One output file   | `AUTOMATE_SCRIPT_MAX_OUTPUT_FILE_BYTES`  | `536870912` bytes (512 MiB) | All through the output watchdog; macOS/Linux also use `RLIMIT_FSIZE` |
| All output files  | `AUTOMATE_SCRIPT_MAX_OUTPUT_TOTAL_BYTES` |  `1073741824` bytes (1 GiB) | Windows, macOS, Linux                                                |
| Output file count | `AUTOMATE_SCRIPT_MAX_OUTPUT_FILES`       |                       `200` | Windows, macOS, Linux                                                |
| Watch interval    | `AUTOMATE_OUTPUT_WATCH_INTERVAL_MS`      |                   `2000` ms | Windows, macOS, Linux                                                |

Captured stdout and stderr are bounded separately. The beginning and end are retained when the middle is dropped. The watchdog scans at intervals, so output may briefly exceed a threshold before the process tree is stopped. Timeouts and cancellation stop the process tree through `taskkill /T /F` on Windows or a process-group kill on macOS/Linux.

**No memory limit is enforced on Windows.** On macOS and Linux, the launcher sets the soft and hard `RLIMIT_AS` to the same value, so an unprivileged script cannot raise it. This bounds address space, which can be much larger than memory actively used by pandas or numpy; increase the value if a legitimate workload hits it. A value of `0` disables the memory or output caps that accept zero. Timeouts and the watch interval must be positive.

These limits do not confine generated code. It runs with this application's access and can read any file this application can read or use the network. The pinned interpreter, locked packages, and launcher protect dependency identity and prevent accidental launcher substitution; they are not a sandbox or network restriction. Restricted execution is required before a target-user pilot.

See [Python Runtime and Script Execution](features/python-runtime-execution.md) for the run record and Settings status.
