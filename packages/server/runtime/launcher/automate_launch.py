"""Application-owned launch hygiene for generated Python.

On macOS/Linux this bounds runaway allocation and file writes. It does not
confine a script or restrict which files it can open. Windows has no resource
limit from this launcher. Generated code has this application's access.
"""

import errno
import os
import runpy
import signal
import sys

MEMORY_EXIT = 93
FILE_SIZE_EXIT = 94
LIMIT_MARKER = "AUTOMATE_LAUNCH_LIMIT:"


def limit_exit(kind, code):
    """Mark a launcher-enforced limit before returning its reserved code."""
    os.write(2, (LIMIT_MARKER + kind + "\n").encode())
    return code


def apply_limits(platform=None, resource_module=None):
    """Set equal soft and hard POSIX caps; zero disables each cap."""
    if platform is None:
        platform = sys.platform
    if platform == "win32":
        return
    if resource_module is None:
        import resource as resource_module
    for name, key in (("RLIMIT_AS", "AUTOMATE_MEMORY_LIMIT_BYTES"),
                      ("RLIMIT_FSIZE", "AUTOMATE_MAX_OUTPUT_FILE_BYTES")):
        value = int(os.environ.get(key, "0"))
        if value > 0:
            resource_module.setrlimit(getattr(resource_module, name), (value, value))


def main():
    """Run the chosen entrypoint after applying host-supported caps."""
    entrypoint = os.path.abspath(sys.argv[1])
    apply_limits()
    if sys.platform != "win32":
        signal.signal(signal.SIGXFSZ, lambda _signum, _frame: os._exit(limit_exit("output_bytes", FILE_SIZE_EXIT)))
    sys.path.insert(0, os.path.dirname(entrypoint))
    sys.argv = [entrypoint, *sys.argv[2:]]
    try:
        runpy.run_path(entrypoint, run_name="__main__")
    except MemoryError:
        if sys.platform == "win32" or int(os.environ.get("AUTOMATE_MEMORY_LIMIT_BYTES", "0")) <= 0:
            raise
        return limit_exit("memory", MEMORY_EXIT)
    except OSError as error:
        if sys.platform != "win32" and error.errno == errno.EFBIG:
            return limit_exit("output_bytes", FILE_SIZE_EXIT)
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
