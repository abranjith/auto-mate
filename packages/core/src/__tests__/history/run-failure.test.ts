import { describe, expect, it } from 'vitest';
import { describeLimitBreach } from '../../execution/runtime-environment';
import { describeRunFailure, type RunFailureInput } from '../../history/run-failure';
import type { GenerationAttempt } from '../../contracts/generation-api';

const base: RunFailureInput = { status: 'failed', errorCode: null, errorMessage: 'It stopped.', correlationId: null, scriptRun: null, artifacts: [], checks: null, generation: null, reviewFeedback: null };
const script: NonNullable<RunFailureInput['scriptRun']> = { status: 'timed_out', exitCode: null, limitBreached: 'time', manifestPresent: false, declaredOutputCount: 0 };

describe('describeRunFailure', () => {
  it('prioritizes an interruption over a script run', () => {
    const result = describeRunFailure({ ...base, errorCode: 'EXECUTION_INTERRUPTED', scriptRun: script, correlationId: 'abc' });
    expect(result.headline).toBe('Interrupted');
    expect(result.technical).toEqual({ code: 'EXECUTION_INTERRUPTED', correlationId: 'abc' });
  });
  it('keeps FEAT-108 limit wording verbatim', () => {
    const result = describeRunFailure({ ...base, scriptRun: script });
    expect(result.limit).toBe(describeLimitBreach('time'));
  });
  it('points blocked checks to their report', () => {
    const result = describeRunFailure({ ...base, checks: { status: 'blocked', summary: 'Two checks failed.' } });
    expect(result.headline).toBe("The code didn't pass its checks.");
    expect(result.nextSteps.map((step) => step.action)).toEqual(['open_checks', 'retry_with_detail']);
  });
  it('shows a generation give-up and the transcript step', () => {
    const attempt: GenerationAttempt = { id: 1, executionId: 2, codeVersionId: 3, attempt: 1, status: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, exitCode: 1, manifestPresent: false, diagnosticDigest: null, droppedLineCount: 0, durationMs: 5, startedAt: '2026-09-26T10:00:00.000Z', settledAt: '2026-09-26T10:00:01.000Z', diagnostics: null };
    const result = describeRunFailure({ ...base, generation: { summary: 'All attempts stopped.', attempts: [attempt] } });
    expect(result.headline).toBe("I couldn't write working code for this.");
    expect(result.attempts).toEqual(['Attempt 1: 1 of 3 tests failed.']);
    expect(result.nextSteps.map((step) => step.action)).toContain('open_transcript');
  });
  it('names cancellation, rejection, and fallback separately', () => {
    expect(describeRunFailure({ ...base, status: 'aborted' }).headline).toBe('You cancelled this run.');
    expect(describeRunFailure({ ...base, status: 'rejected', reviewFeedback: 'Wrong total' }).detail).toContain('Wrong total');
    expect(describeRunFailure(base).detail).toBe('It stopped.');
    for (const status of ['aborted', 'rejected', 'failed'] as const) expect(describeRunFailure({ ...base, status }).headline).not.toMatch(/[A-Z]+_[A-Z_]+/);
  });
});
