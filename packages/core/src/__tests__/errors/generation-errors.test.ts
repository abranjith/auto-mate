import { describe, expect, it } from 'vitest';
import { AutoMateError } from '../../errors/automate-error';
import { ERROR_CODES } from '../../errors/error-codes';
import {
  CodeTooLargeError,
  CodeVersionImmutableError,
  CodeVersionNotFinalError,
  CodeVersionNotFoundError,
  ExecutionNotRetryableError,
  FixtureGenerationError,
  GenerationAttemptsExhaustedError,
  GenerationCostLimitError,
  GenerationTimeoutError,
  InvalidCodePathError,
  PythonRuntimeUnavailableError,
  formatDurationMs,
} from '../../errors/generation-errors';

const cases: readonly [AutoMateError, string][] = [
  [new GenerationAttemptsExhaustedError(3, 3), ERROR_CODES.GENERATION_ATTEMPTS_EXHAUSTED],
  [new GenerationTimeoutError(600_000, 603_000), ERROR_CODES.GENERATION_TIMEOUT],
  [new GenerationCostLimitError(0.5, 0.52), ERROR_CODES.GENERATION_COST_LIMIT],
  [new CodeVersionNotFoundError(7), ERROR_CODES.CODE_VERSION_NOT_FOUND],
  [new CodeVersionImmutableError(7), ERROR_CODES.CODE_VERSION_IMMUTABLE],
  [new CodeVersionNotFinalError(), ERROR_CODES.CODE_VERSION_NOT_FINAL],
  [new InvalidCodePathError('main.txt', 'it is not a Python file; use a `.py` path.'), ERROR_CODES.INVALID_CODE_PATH],
  [new CodeTooLargeError(262_144, 307_200), ERROR_CODES.CODE_TOO_LARGE],
  [new PythonRuntimeUnavailableError('uv', 'winget install astral-sh.uv'), ERROR_CODES.PYTHON_RUNTIME_UNAVAILABLE],
  [new FixtureGenerationError(2), ERROR_CODES.FIXTURE_GENERATION_FAILED],
  [new ExecutionNotRetryableError(4, 'generating'), ERROR_CODES.EXECUTION_NOT_RETRYABLE],
];

describe('generation errors', () => {
  it.each(cases.map(([error, code]) => [error.name, error, code] as const))('%s is a stable-coded AutoMateError with a stack-free wire shape', (_name, error, code) => {
    expect(error).toBeInstanceOf(AutoMateError);
    expect(error.code).toBe(code);
    expect(error.toJSON()).toEqual({ error: { code, message: error.message } });
    expect(JSON.stringify(error.toJSON())).not.toMatch(/stack|at .+:\d+:\d+/);
  });

  it('names the limit and the actual count when attempts run out', () => {
    expect(new GenerationAttemptsExhaustedError(3, 3).message).toBe("This run used all 3 attempts without getting the tests to pass. Tell me what went wrong and I'll try again.");
    expect(new GenerationAttemptsExhaustedError(5, 2).message).toContain('used 2 of 5 attempts');
    expect(new GenerationAttemptsExhaustedError(1, 1).message).toContain('used its only attempt');
  });

  it('names both figures for the time and cost limits', () => {
    expect(new GenerationTimeoutError(600_000, 603_000).message).toContain('10 minutes 3 seconds, past its limit of 10 minutes');
    const cost = new GenerationCostLimitError(0.5, 0.52).message;
    expect(cost).toContain('$0.5200');
    expect(cost).toContain('$0.5000');
  });

  it('names both sizes when a file is too large', () => {
    const message = new CodeTooLargeError(262_144, 307_200).message;
    expect(message).toContain('307,200');
    expect(message).toContain('262,144');
  });

  it('names the missing tool and its install command without any absolute path', () => {
    const uv = new PythonRuntimeUnavailableError('uv', 'winget install astral-sh.uv').message;
    expect(uv).toContain('uv is not available');
    expect(uv).toContain('winget install astral-sh.uv');
    const python = new PythonRuntimeUnavailableError('Python', 'curl -LsSf https://astral.sh/uv/install.sh | sh').message;
    expect(python).toContain('Python 3.11 or newer');
    for (const message of [uv, python]) expect(message).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });

  it('names a fixture failure by position, never by filename', () => {
    expect(new FixtureGenerationError(2).message).toBe('File 2 could not be turned into test data because its analysis did not finish.');
  });

  it('formats durations in plain English', () => {
    expect(formatDurationMs(0)).toBe('0 seconds');
    expect(formatDurationMs(1_000)).toBe('1 second');
    expect(formatDurationMs(45_000)).toBe('45 seconds');
    expect(formatDurationMs(60_000)).toBe('1 minute');
    expect(formatDurationMs(125_000)).toBe('2 minutes 5 seconds');
    expect(formatDurationMs(-5)).toBe('0 seconds');
  });
});
