import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';
import { describeLimitBreach, type LimitBreach } from '../execution/runtime-environment';

export class RuntimeNotPreparedError extends AutoMateError { constructor(kind: 'script' | 'verify') { super(ERROR_CODES.RUNTIME_NOT_PREPARED, `The ${kind} Python environment is not ready. Prepare it and try again.`); } }
export class RuntimePrepareFailedError extends AutoMateError { constructor(step: string) { super(ERROR_CODES.RUNTIME_PREPARE_FAILED, `The Python environment could not be prepared during ${step}. Try preparing it again.`); } }
export class RuntimeLockMismatchError extends AutoMateError { constructor() { super(ERROR_CODES.RUNTIME_LOCK_MISMATCH, 'The committed Python lockfile does not match the declared dependencies. This is a build problem; the maintainer must run pnpm runtime:lock in the repository.'); } }
export class LauncherIntegrityError extends AutoMateError { constructor() { super(ERROR_CODES.LAUNCHER_INTEGRITY, 'The Python launcher has changed since the environment was prepared. Prepare the environment again before running.'); } }
export class ScriptLimitExceededError extends AutoMateError { constructor(readonly breach: LimitBreach) { super(ERROR_CODES.SCRIPT_LIMIT_EXCEEDED, describeLimitBreach(breach)); } }
export class NonPythonEntrypointError extends AutoMateError { constructor() { super(ERROR_CODES.NON_PYTHON_ENTRYPOINT, 'The selected entrypoint is not a Python .py file. Choose a Python script before running.'); } }
