// Generation failures (FEAT-106). Two audiences read these: a tool error goes
// back to the model and says exactly what to change; a user-facing error names
// the limit, the actual value, and the next step. Neither ever carries an
// absolute path, a stack, or generated code.
import { AutoMateError } from './automate-error';
import { ERROR_CODES } from './error-codes';

/**
 * Render milliseconds as plain English.
 *
 * @param ms A non-negative duration.
 * @returns For example `10 minutes`, `2 minutes 5 seconds`, or `45 seconds`.
 * @example formatDurationMs(600_000) // '10 minutes'
 */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (minutes === 0) return plural(seconds, 'second');
  return seconds === 0 ? plural(minutes, 'minute') : `${plural(minutes, 'minute')} ${plural(seconds, 'second')}`;
}

/** Strip control characters and cap a model-supplied path before it is echoed back in a message. */
function echo(path: string): string {
  const printable = [...path].filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f).join('');
  return printable.length > 64 ? `${printable.slice(0, 63)}…` : printable;
}

export class GenerationAttemptsExhaustedError extends AutoMateError { constructor(readonly limit: number, readonly used: number) { super(ERROR_CODES.GENERATION_ATTEMPTS_EXHAUSTED, `This run used ${used >= limit ? (limit === 1 ? 'its only' : `all ${limit}`) : `${used} of ${limit}`} attempt${limit === 1 ? '' : 's'} without getting the tests to pass. Tell me what went wrong and I'll try again.`); } }
export class GenerationTimeoutError extends AutoMateError { constructor(readonly limitMs: number, readonly elapsedMs: number) { super(ERROR_CODES.GENERATION_TIMEOUT, `Writing and testing the script ran for ${formatDurationMs(elapsedMs)}, past its limit of ${formatDurationMs(limitMs)}, so it was stopped. The attempts so far are kept below.`); } }
export class GenerationCostLimitError extends AutoMateError { constructor(readonly limitUsd: number, readonly spentUsd: number) { super(ERROR_CODES.GENERATION_COST_LIMIT, `This run reached $${spentUsd.toFixed(4)} of provider cost, past its limit of $${limitUsd.toFixed(4)}, so it was stopped. The attempts so far are kept below.`); } }
export class CodeVersionNotFoundError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.CODE_VERSION_NOT_FOUND, `Code version ${id} was not found.`); } }
export class CodeVersionImmutableError extends AutoMateError { constructor(id: number) { super(ERROR_CODES.CODE_VERSION_IMMUTABLE, `Code version ${id} is sealed and cannot be changed. Write the file again to start the next attempt.`); } }
export class CodeVersionNotFinalError extends AutoMateError { constructor() { super(ERROR_CODES.CODE_VERSION_NOT_FINAL, 'The agent stopped without choosing a final version of the script. Tell me what went wrong and I\'ll try again.'); } }
export class InvalidCodePathError extends AutoMateError { constructor(path: string, reason: string) { super(ERROR_CODES.INVALID_CODE_PATH, `\`${echo(path)}\` cannot be used: ${reason}`); } }
export class CodeTooLargeError extends AutoMateError { constructor(readonly limitBytes: number, readonly actualBytes: number) { super(ERROR_CODES.CODE_TOO_LARGE, `The file is ${actualBytes.toLocaleString('en-US')} bytes; the limit is ${limitBytes.toLocaleString('en-US')} bytes. Split it into smaller modules or shorten it.`); } }
export class PythonRuntimeUnavailableError extends AutoMateError { constructor(readonly tool: 'uv' | 'Python', readonly installHint: string, message?: string) { super(ERROR_CODES.PYTHON_RUNTIME_UNAVAILABLE, message ?? `${tool === 'uv' ? 'uv is' : 'Python 3.11 or newer is'} not available, so the generated tests cannot run. Install it with: ${installHint}`); } }
export class FixtureGenerationError extends AutoMateError { constructor(position: number, reason = 'its analysis did not finish') { super(ERROR_CODES.FIXTURE_GENERATION_FAILED, `File ${position} could not be turned into test data because ${reason}.`); } }
export class ExecutionNotRetryableError extends AutoMateError { constructor(id: number, status: string) { super(ERROR_CODES.EXECUTION_NOT_RETRYABLE, `Run ${id} is still ${status}. Wait for it to finish or stop it before trying again.`); } }
