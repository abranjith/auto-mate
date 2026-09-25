import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PythonRunOutcome, PythonRunner, PythonRunRequest, PythonRunResult } from '../../execution/python-runner';

describe('PythonRunner seam', () => {
  it('has exactly three methods, so FEAT-108 widening the seam is a deliberate act', () => {
    expectTypeOf<keyof PythonRunner>().toEqualTypeOf<'probe' | 'ensureEnvironment' | 'run'>();
  });

  it('keeps the outcome union closed', () => {
    expectTypeOf<PythonRunOutcome>().toEqualTypeOf<'passed' | 'failed' | 'errored' | 'timed_out' | 'aborted'>();
    expectTypeOf<PythonRunResult['outcome']>().toEqualTypeOf<PythonRunOutcome>();
  });

  it('takes an application-built argument vector and a cancellation signal, not a shell string', () => {
    expectTypeOf<PythonRunRequest['args']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<PythonRunRequest['signal']>().toEqualTypeOf<AbortSignal>();
    const result: PythonRunResult = { outcome: 'passed', exitCode: 0, stdout: '', stderr: '', droppedBytes: 0, durationMs: 1 };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
