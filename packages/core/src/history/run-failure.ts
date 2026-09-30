import { ERROR_CODES } from '../errors/error-codes';
import { INTERRUPTION_MESSAGES, type ExecutionStatus } from '../conversation/execution-state';
import { describeAttempt } from '../generation/index';
import type { GenerationAttempt } from '../contracts/generation-api';
import { describeRunOutcome, type NextStep, type RunOutcomeInput } from '../artifacts/next-step';
import { describeRunState } from './run-wording';

export interface RunFailure {
  readonly tone: 'problem' | 'notice';
  readonly headline: string;
  readonly detail: string | null;
  readonly limit: string | null;
  readonly attempts: readonly string[];
  readonly nextSteps: readonly NextStep[];
  readonly technical: { readonly code: string | null; readonly correlationId: string | null };
}

export interface RunFailureInput {
  readonly status: ExecutionStatus;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly correlationId: string | null;
  readonly scriptRun: RunOutcomeInput | null;
  readonly artifacts: readonly unknown[];
  readonly checks: { readonly status: string; readonly summary: string } | null;
  readonly generation: { readonly summary: string; readonly attempts: readonly GenerationAttempt[] } | null;
  readonly reviewFeedback: string | null;
}

const retry: NextStep = { action: 'retry_with_detail', label: 'Try again, telling me more about what you want' };
const transcript: NextStep = { action: 'open_transcript', label: 'See what happened, step by step' };

/**
 * Choose one readable outcome from the recorded causes, in priority order.
 * @param input The execution, script, checks, generation, and review facts.
 * @returns One headline, optional detail and limit, next steps, and hidden diagnostics.
 * @example describeRunFailure({ status: 'aborted', errorCode: null, errorMessage: null, correlationId: null, scriptRun: null, artifacts: [], checks: null, generation: null, reviewFeedback: null }).headline
 */
export function describeRunFailure(input: RunFailureInput): RunFailure {
  const technical = { code: input.errorCode, correlationId: input.correlationId };
  const result = (tone: RunFailure['tone'], headline: string, detail: string | null, nextSteps: readonly NextStep[], limit: string | null = null, attempts: readonly string[] = []): RunFailure => ({ tone, headline, detail, nextSteps, limit, attempts, technical });
  if (input.errorCode === ERROR_CODES.EXECUTION_INTERRUPTED || input.errorCode === ERROR_CODES.EXECUTION_STOPPED_ON_SHUTDOWN) return result('problem', describeRunState({ status: input.status, errorCode: input.errorCode }).label, input.errorMessage ?? INTERRUPTION_MESSAGES.waiting, [retry]);
  if (input.scriptRun) {
    const outcome = describeRunOutcome(input.scriptRun, input.artifacts);
    return result(outcome.tone === 'success' ? 'notice' : outcome.tone, outcome.headline, outcome.detail, outcome.nextSteps, outcome.limit);
  }
  if (input.checks?.status === 'blocked') return result('problem', "The code didn't pass its checks.", input.checks.summary, [{ action: 'open_checks', label: 'See what the checks found' }, retry]);
  if (input.generation) return result('problem', "I couldn't write working code for this.", input.generation.summary, [retry, transcript], null, input.generation.attempts.map(describeAttempt));
  if (input.status === 'aborted') return result('notice', 'You cancelled this run.', input.errorMessage, [retry]);
  if (input.status === 'rejected') return result('notice', "You said this wasn't right.", input.reviewFeedback ? `“${input.reviewFeedback}”` : null, [retry]);
  return result('problem', "This run didn't finish.", input.errorMessage, [retry]);
}
