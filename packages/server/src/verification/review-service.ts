// ---------------------------------------------------------------------------
// Post-run review (FEAT-107 TASK-012): running and succeeding are different
// questions. A run that exited 0 waits in `awaiting_review` until a person
// says whether it did what they wanted.
//
//   accepted → `completed` (now meaning a person said so)
//   rejected → `rejected`, the feedback stored, and a NEW execution seeded
//              through FEAT-106's retry path with `trigger = 'feedback'`
//
// The rejected run is never mutated beyond its verdict: its verification,
// approval, run, and transcript stay readable, and history keeps both. The
// person's verdict is recorded BEFORE the retry is attempted, so a retry
// refused at the concurrency cap never rolls the verdict back.
//
// Feedback is user input. It reaches the provider only as the retry's
// `user_prompt` source (the guidance), and it is never logged.
// ---------------------------------------------------------------------------

import { AutoMateError, ExecutionNotFoundError, MAX_REVIEW_FEEDBACK_CHARS, ReviewNotPendingError, ValidationError, feedbackProblem, type ReviewRequest, type ReviewResponse } from '@automate/core';
import type { Logger } from 'pino';
import type { ExecutionRepository, ExecutionRow } from '../db/repositories/execution-repository';
import type { ExecutionStateWriter, Publish } from './execution-state-writer';

export interface ReviewServiceDependencies {
  readonly executions: ExecutionRepository;
  readonly state: ExecutionStateWriter;
  readonly publish: Publish;
  /** FEAT-106's retry, with the feedback as guidance and `trigger = 'feedback'`. */
  readonly retry: (executionId: number, feedback: string) => { readonly execution: ExecutionRow };
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly maxFeedbackChars?: number;
}

/** Records a person's verdict on a result. */
export class ReviewService {
  constructor(private readonly deps: ReviewServiceDependencies) {}

  /**
   * Accept or reject a result.
   * @returns The execution's new status and, for a rejection, the retry it seeded.
   * @throws ReviewNotPendingError outside `awaiting_review`; ValidationError for blank or over-long feedback; the retry's own error (for example EXECUTION_LIMIT_REACHED) after the verdict is recorded.
   */
  review(executionId: number, request: ReviewRequest): ReviewResponse {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    if (execution.status !== 'awaiting_review') throw new ReviewNotPendingError(executionId, execution.status);
    if (request.verdict === 'accepted') return this.accept(executionId);
    const problem = feedbackProblem(request.feedback, this.deps.maxFeedbackChars ?? MAX_REVIEW_FEEDBACK_CHARS);
    if (problem) throw new ValidationError(problem);
    return this.reject(executionId, request.feedback!);
  }

  private accept(executionId: number): ReviewResponse {
    this.deps.executions.markReviewed(executionId, 'accepted', null);
    this.deps.publish(executionId, { type: 'review_decided', verdict: 'accepted', retryExecutionId: null, at: new Date().toISOString() });
    this.deps.state.announce(executionId, 'awaiting_review', 'completed');
    this.deps.logger.info({ executionId, verdict: 'accepted' }, 'review decided');
    return { status: 'completed', retryExecutionId: null };
  }

  private reject(executionId: number, feedback: string): ReviewResponse {
    this.deps.executions.markReviewed(executionId, 'rejected', feedback);
    let retry: ExecutionRow | null = null;
    let failure: unknown = null;
    try { retry = this.deps.retry(executionId, feedback).execution; }
    catch (cause) { failure = cause; }
    this.deps.publish(executionId, { type: 'review_decided', verdict: 'rejected', retryExecutionId: retry?.id ?? null, at: new Date().toISOString() });
    this.deps.state.announce(executionId, 'awaiting_review', 'rejected');
    this.deps.logger.info({ executionId, verdict: 'rejected', retryExecutionId: retry?.id ?? null }, 'review decided');
    if (failure) {
      this.deps.logger.warn({ executionId, code: failure instanceof AutoMateError ? failure.code : 'UNKNOWN' }, 'feedback retry could not start; the rejection stands');
      throw failure;
    }
    return { status: 'rejected', retryExecutionId: retry!.id };
  }
}
