import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionLimitReachedError, ReviewNotPendingError } from '@automate/core';
import type { FakePythonRun } from '../../execution/testing/fake-python-runner';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createVerificationHarness, type VerificationHarness } from '../support/verification-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

const producing: FakePythonRun = { onRun: (request) => { writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'totals.csv'), 'a\n'); writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'T', description: '' }] })); } };

/** Generate, verify, approve, and run to `awaiting_review`. */
async function atReview() {
  const h = await createVerificationHarness({ pythonRuns: [{}, {}, producing], onApproved: () => undefined });
  harnesses.push(h);
  await h.runToGate();
  await h.approve();
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
  expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
  return h;
}
const snapshot = (h: VerificationHarness) => ({
  verification: h.repos.verifications.getWithChecks(h.repos.verifications.getLatest(h.execution.id)!.id),
  approvals: h.repos.approvals.listByExecution(h.execution.id),
  run: h.repos.scriptRuns.getByExecution(h.execution.id),
  code: h.repos.versions.listByExecution(h.execution.id),
});

describe('ReviewService', () => {
  it('accepts: awaiting_review → completed with reviewed_at stamped', async () => {
    const h = await atReview();
    expect(h.review.review(h.execution.id, { verdict: 'accepted' })).toEqual({ status: 'completed', retryExecutionId: null });
    const row = h.repos.executions.getById(h.execution.id)!;
    expect(row).toMatchObject({ status: 'completed', reviewFeedback: null });
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(h.transcript().slice(-2)).toEqual([expect.objectContaining({ type: 'review_decided', verdict: 'accepted' }), expect.objectContaining({ type: 'state_changed', from: 'awaiting_review', to: 'completed' })]);
  });

  it('rejects: stores the words verbatim, seeds exactly one feedback retry, and leaves the original untouched', async () => {
    const h = await atReview();
    const before = snapshot(h);
    const feedback = 'The totals include refunds — exclude rows where amount < 0.\nAlso sort by region.';
    const response = h.review.review(h.execution.id, { verdict: 'rejected', feedback });
    expect(response.status).toBe('rejected');
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'rejected', reviewFeedback: feedback });
    const retries = h.repos.executions.listByTask(h.task.id).filter(({ id }) => id !== h.execution.id);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ id: response.retryExecutionId, trigger: 'feedback', retryOfExecutionId: h.execution.id, guidance: feedback });
    expect(h.transcript().find(({ type }) => type === 'review_decided')).toMatchObject({ verdict: 'rejected', retryExecutionId: response.retryExecutionId });
    expect(snapshot(h)).toEqual(before);
    await h.quiesce();
    expect(h.transcript(response.retryExecutionId!).filter(({ type }) => type === 'user_prompt').map((event) => (event as { text: string }).text)).toContain(feedback);
  });

  it.each([['empty', ''], ['whitespace-only', '  \n\t '], ['absent', undefined]])('rejects %s feedback with VALIDATION_ERROR and creates nothing', async (_name, feedback) => {
    const h = await atReview();
    expect(() => h.review.review(h.execution.id, { verdict: 'rejected', ...(feedback === undefined ? {} : { feedback }) })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(1);
  });

  it('rejects feedback one character over the cap', async () => {
    const h = await atReview();
    expect(() => h.review.review(h.execution.id, { verdict: 'rejected', feedback: 'x'.repeat(2_001) })).toThrow(/limited to 2,000 characters/);
    expect(() => h.review.review(h.execution.id, { verdict: 'rejected', feedback: 'x'.repeat(2_000) })).not.toThrow();
  });

  it('refuses a review outside awaiting_review, naming the actual status, and never twice', async () => {
    const h = await atReview();
    h.review.review(h.execution.id, { verdict: 'accepted' });
    expect(() => h.review.review(h.execution.id, { verdict: 'rejected', feedback: 'again' })).toThrow(ReviewNotPendingError);
    expect(() => h.review.review(h.execution.id, { verdict: 'accepted' })).toThrow(/is completed/);
    expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(1);
  });

  it('refuses a review while still executing', async () => {
    const h = await createVerificationHarness({ onApproved: () => undefined });
    harnesses.push(h);
    await h.runToGate();
    await h.approve();
    expect(() => h.review.review(h.execution.id, { verdict: 'accepted' })).toThrow(/is executing/);
  });

  it('keeps the rejection when the retry is refused at the concurrency cap', async () => {
    const h = await atReview();
    h.registry.assertCapacity = () => { throw new ExecutionLimitReachedError(); };
    expect(() => h.review.review(h.execution.id, { verdict: 'rejected', feedback: 'wrong totals' })).toThrow(ExecutionLimitReachedError);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'rejected', reviewFeedback: 'wrong totals' });
    expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(1);
  });
});
