import { useState, type FormEvent } from 'react';
import { MAX_REVIEW_FEEDBACK_CHARS, feedbackProblem, type ReviewResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';

/**
 * The review: finishing is not the same as being right. **Yes** completes
 * the run; **No — here's what's wrong** starts a new attempt that is told
 * what to fix. The rejected run stays readable.
 */
export function ReviewPanel({ onReview, onRetried }: { onReview: (verdict: 'accepted' | 'rejected', feedback?: string) => Promise<ReviewResponse>; onRetried?: (retryExecutionId: number) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (verdict: 'accepted' | 'rejected') => {
    setPending(true); setError(undefined);
    try {
      const response = await onReview(verdict, verdict === 'rejected' ? feedback : undefined);
      if (response.retryExecutionId !== null) onRetried?.(response.retryExecutionId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your answer could not be saved.'); }
    finally { setPending(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = feedbackProblem(feedback);
    if (problem) { setError(problem); return; }
    void send('rejected');
  };
  return (
    <section className={ds.reviewPanel} aria-label="Review the result">
      <h2 className={ds.sectionTitle}>Did this do what you wanted?</h2>
      {rejecting ? (
        <form className={ds.stackTight} onSubmit={submit}>
          <label className={ds.field}>
            <span className={ds.label}>What is wrong? The next attempt will be told exactly this.</span>
            <textarea className={ds.textarea} value={feedback} maxLength={MAX_REVIEW_FEEDBACK_CHARS} onChange={(event) => setFeedback(event.target.value)} />
          </label>
          <span className={ds.counter}>{feedback.length.toLocaleString('en-US')} / {MAX_REVIEW_FEEDBACK_CHARS.toLocaleString('en-US')}</span>
          <div className={ds.row}>
            <button type="submit" className={ds.btnPrimary} disabled={pending}>Try again with this</button>
            <button type="button" className={ds.btnGhost} disabled={pending} onClick={() => { setRejecting(false); setError(undefined); }}>Back</button>
          </div>
        </form>
      ) : (
        <div className={ds.row}>
          <button type="button" className={ds.btnPrimary} disabled={pending} onClick={() => void send('accepted')}>Yes, this is what I wanted</button>
          <button type="button" className={ds.btnGhost} disabled={pending} onClick={() => setRejecting(true)}>No — here's what's wrong</button>
        </div>
      )}
      {error ? <p className={ds.statusDanger} role="alert">{error}</p> : null}
    </section>
  );
}
