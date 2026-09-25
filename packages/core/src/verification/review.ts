// Post-run review (FEAT-107 TASK-001/012). Process exit is not acceptance:
// a run that exits 0 parks in `awaiting_review` until a person answers.

import { MAX_REVIEW_FEEDBACK_CHARS } from './limits';

export const REVIEW_VERDICTS = ['accepted', 'rejected'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** A person's answer to "Did this do what you wanted?". Feedback is user input. */
export interface ReviewDecision {
  readonly verdict: ReviewVerdict;
  readonly feedback?: string;
}

/**
 * Check a rejection's feedback: non-blank and within the limit.
 *
 * @param feedback The person's words.
 * @param limit The character cap; defaults to `MAX_REVIEW_FEEDBACK_CHARS`.
 * @returns Null when valid, otherwise a plain-English reason.
 * @example feedbackProblem('   ') // 'Say what was wrong so the next attempt can fix it.'
 */
export function feedbackProblem(feedback: string | undefined, limit: number = MAX_REVIEW_FEEDBACK_CHARS): string | null {
  if (!feedback || feedback.trim().length === 0) return 'Say what was wrong so the next attempt can fix it.';
  if (feedback.length > limit) return `Feedback is limited to ${limit.toLocaleString('en-US')} characters; this is ${feedback.length.toLocaleString('en-US')}.`;
  return null;
}
