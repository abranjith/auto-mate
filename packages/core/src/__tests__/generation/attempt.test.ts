import { describe, expect, it } from 'vitest';
import { describeAttempt, summarizeAttempts, type AttemptSummaryInput } from '../../generation/attempt';

const attempt = (overrides: Partial<AttemptSummaryInput> & Pick<AttemptSummaryInput, 'attempt' | 'status'>): AttemptSummaryInput => ({
  refusalReason: null,
  testsTotal: null,
  testsPassed: null,
  testsFailed: null,
  ...overrides,
});

describe('describeAttempt', () => {
  it.each([
    [attempt({ attempt: 2, status: 'passed', testsTotal: 3, testsPassed: 3, testsFailed: 0 }), 'Attempt 2: all 3 tests passed.'],
    [attempt({ attempt: 1, status: 'passed', testsTotal: 1, testsPassed: 1, testsFailed: 0 }), 'Attempt 1: all 1 test passed.'],
    [attempt({ attempt: 1, status: 'passed' }), 'Attempt 1: the tests passed.'],
    [attempt({ attempt: 1, status: 'failed', testsTotal: 3, testsPassed: 2, testsFailed: 1 }), 'Attempt 1: 1 of 3 tests failed.'],
    [attempt({ attempt: 1, status: 'failed' }), 'Attempt 1: the tests failed.'],
    [attempt({ attempt: 3, status: 'errored' }), 'Attempt 3: the tests could not start, for example because of an import or syntax error.'],
    [attempt({ attempt: 1, status: 'timed_out' }), 'Attempt 1: the tests ran past their time limit and were stopped.'],
    [attempt({ attempt: 1, status: 'aborted' }), 'Attempt 1: stopped before the tests finished.'],
    [attempt({ attempt: 1, status: 'running' }), 'Attempt 1: running.'],
  ])('describes %o', (input, expected) => {
    expect(describeAttempt(input)).toBe(expected);
  });

  it('names every refusal reason in plain English rather than as a code', () => {
    for (const reason of ['attempt_limit', 'time_limit', 'cost_limit', 'diagnostics_not_granted', 'runtime_unavailable'] as const) {
      const text = describeAttempt(attempt({ attempt: 4, status: 'refused', refusalReason: reason }));
      expect(text).toMatch(/^Attempt 4 was not run because /);
      expect(text).not.toContain(reason);
    }
  });
});

describe('summarizeAttempts', () => {
  const failures = [1, 2, 3].map((n) => attempt({ attempt: n, status: 'failed', testsTotal: 3, testsPassed: 2, testsFailed: 1 }));

  it('states exhaustion with the limit, then each attempt in order', () => {
    const text = summarizeAttempts([...failures].reverse(), { limit: 3, outcome: 'exhausted' });
    expect(text).toBe('Used all 3 attempts without getting the tests to pass. Attempt 1: 1 of 3 tests failed. Attempt 2: 1 of 3 tests failed. Attempt 3: 1 of 3 tests failed.');
  });

  it('does not count a refused call as a used attempt', () => {
    const text = summarizeAttempts([failures[0]!, attempt({ attempt: 2, status: 'refused', refusalReason: 'diagnostics_not_granted' })], { limit: 3, outcome: 'exhausted' });
    expect(text).toMatch(/^Used 1 of 3 attempts/);
  });

  it('says plainly when the chosen version passed, failed, or was never tested', () => {
    expect(summarizeAttempts(failures.slice(0, 1), { limit: 3, outcome: 'finalized', finalAttempt: 1, finalTestsPassed: true })).toMatch(/^Chose attempt 1 of 3 as the final version, which passed its own tests\./);
    expect(summarizeAttempts(failures, { limit: 3, outcome: 'finalized', finalAttempt: 3, finalTestsPassed: false })).toContain('although its own tests did not pass');
    expect(summarizeAttempts([], { limit: 3, outcome: 'finalized', finalAttempt: 1, finalTestsPassed: null })).toContain('which was never tested');
  });

  it.each([
    ['timed_out', 'Stopped at the time limit after 3 attempts.'],
    ['cost_limit', 'Stopped at the cost limit after 3 attempts.'],
    ['aborted', 'Stopped on request after 3 attempts.'],
    ['incomplete', 'The agent stopped without choosing a final version after 3 attempts.'],
  ] as const)('headlines %s', (outcome, expected) => {
    expect(summarizeAttempts(failures, { limit: 3, outcome })).toMatch(new RegExp(`^${expected.replace(/\./g, '\\.')}`));
  });

  it('has a sensible sentence with no attempts and no outcome', () => {
    expect(summarizeAttempts([], { limit: 3 })).toBe('No attempts have run yet.');
    expect(summarizeAttempts(failures.slice(0, 1), { limit: 3 })).toBe('Attempt 1: 1 of 3 tests failed.');
    expect(summarizeAttempts([], { limit: 1, outcome: 'aborted' })).toBe('Stopped on request after 0 attempts.');
  });
});
