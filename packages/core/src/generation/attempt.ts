// Plain-English attempt summaries (FEAT-106). One wording, shared by the API,
// the transcript's `generation_settled` event, and the UI, so a person reads
// the same sentence wherever they look.

import type { AttemptStatus, GenerationOutcome, RefusalReason } from '../contracts/generation-api';

/** The attempt fields a summary reads; any `GenerationAttempt` satisfies it. */
export interface AttemptSummaryInput {
  readonly attempt: number;
  readonly status: AttemptStatus;
  readonly refusalReason: RefusalReason | null;
  readonly testsTotal: number | null;
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
}

/** How the generation phase ended, and which version (if any) it ended on. */
export interface AttemptSummaryOptions {
  readonly limit: number;
  readonly outcome?: GenerationOutcome;
  readonly finalAttempt?: number | null;
  readonly finalTestsPassed?: boolean | null;
}

const REFUSALS: Readonly<Record<RefusalReason, string>> = {
  attempt_limit: 'every allowed attempt had already been used',
  time_limit: 'the time limit had been reached',
  cost_limit: 'the cost limit had been reached',
  diagnostics_not_granted: 'sending failure details to the AI was not approved, so the application stopped rather than repair on data you did not agree to send',
  runtime_unavailable: 'uv or Python is not installed on this computer',
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Describe one attempt in a sentence.
 *
 * @param attempt One attempt row or view.
 * @returns For example `Attempt 1: 1 of 3 tests failed.`
 * @example describeAttempt({ attempt: 2, status: 'passed', refusalReason: null, testsTotal: 3, testsPassed: 3, testsFailed: 0 })
 */
export function describeAttempt(attempt: AttemptSummaryInput): string {
  const label = `Attempt ${attempt.attempt}`;
  const total = attempt.testsTotal;
  switch (attempt.status) {
    case 'passed': return total === null ? `${label}: the tests passed.` : `${label}: all ${plural(total, 'test')} passed.`;
    case 'failed': return total === null || attempt.testsFailed === null ? `${label}: the tests failed.` : `${label}: ${attempt.testsFailed} of ${plural(total, 'test')} failed.`;
    case 'errored': return `${label}: the tests could not start, for example because of an import or syntax error.`;
    case 'timed_out': return `${label}: the tests ran past their time limit and were stopped.`;
    case 'aborted': return `${label}: stopped before the tests finished.`;
    case 'running': return `${label}: running.`;
    case 'refused': return `${label} was not run because ${REFUSALS[attempt.refusalReason ?? 'attempt_limit']}.`;
  }
}

/** The headline sentence for how the whole phase ended. */
function headline(tested: number, options: AttemptSummaryOptions): string | null {
  switch (options.outcome) {
    case undefined: return null;
    case 'finalized': {
      const verdict = options.finalTestsPassed === true ? ', which passed its own tests' : options.finalTestsPassed === false ? ', although its own tests did not pass' : ', which was never tested';
      return `Chose attempt ${options.finalAttempt ?? tested} of ${options.limit} as the final version${verdict}.`;
    }
    case 'exhausted': return `Used ${tested >= options.limit ? `all ${plural(options.limit, 'attempt')}` : `${tested} of ${plural(options.limit, 'attempt')}`} without getting the tests to pass.`;
    case 'timed_out': return `Stopped at the time limit after ${plural(tested, 'attempt')}.`;
    case 'cost_limit': return `Stopped at the cost limit after ${plural(tested, 'attempt')}.`;
    case 'aborted': return `Stopped on request after ${plural(tested, 'attempt')}.`;
    case 'incomplete': return `The agent stopped without choosing a final version after ${plural(tested, 'attempt')}.`;
  }
}

/**
 * Summarize every attempt of one execution in plain English.
 *
 * @param attempts Attempts in any order; they are listed by attempt number.
 * @param options The attempt limit and, once settled, how the phase ended.
 * @returns A headline (when an outcome is given) followed by one sentence per attempt.
 * @example summarizeAttempts(attempts, { limit: 3, outcome: 'exhausted' })
 */
export function summarizeAttempts(attempts: readonly AttemptSummaryInput[], options: AttemptSummaryOptions): string {
  const ordered = [...attempts].sort((left, right) => left.attempt - right.attempt);
  const tested = ordered.filter(({ status }) => status !== 'refused').length;
  const lines = ordered.map(describeAttempt);
  const first = headline(tested, options);
  if (first === null) return lines.length ? lines.join(' ') : 'No attempts have run yet.';
  return [first, ...lines].join(' ');
}
