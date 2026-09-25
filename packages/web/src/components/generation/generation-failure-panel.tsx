import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { AutoMateError, ERROR_CODES, MAX_GUIDANCE_CHARS, describeAttempt, type CreateTaskResponse, type ExecutionSummary, type GenerationAttempt } from '@automate/core';
import { retryExecution } from '../../api/generation-queries';
import { ds } from '../../design-system/tokens';

const CONSENT_CODES: readonly string[] = [ERROR_CODES.DISCLOSURE_CONSENT_STALE, ERROR_CODES.DISCLOSURE_CONSENT_REQUIRED];

/**
 * After a generation run fails: what each attempt did, and a text box —
 * "Tell me what I got wrong and I'll try again." A retry is a NEW run that
 * reuses the approval; the failed run stays failed and readable.
 */
export function GenerationFailurePanel({ execution, attempts, summary, onRetry = retryExecution, onRetried, renderLink = true }: { execution: ExecutionSummary; attempts: readonly GenerationAttempt[]; summary?: string; onRetry?: (executionId: number, guidance: string) => Promise<CreateTaskResponse>; onRetried?: (created: CreateTaskResponse) => void; renderLink?: boolean }) {
  const [guidance, setGuidance] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; consent: boolean }>();
  const [dismissed, setDismissed] = useState(false);
  const tooLong = guidance.length > MAX_GUIDANCE_CHARS;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || tooLong) return;
    setPending(true); setError(undefined);
    try {
      // Not `onRetried?.(await onRetry(...))`: an absent callback would short-circuit and skip the request.
      const created = await onRetry(execution.id, guidance);
      onRetried?.(created);
    }
    catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : 'The retry could not be started.', consent: cause instanceof AutoMateError && CONSENT_CODES.includes(cause.code) });
      setPending(false);
    }
  };
  if (dismissed) return <p className={ds.hint}>This run stays as it is. You can start a new task at any time.</p>;
  return (
    <form className={ds.generationFailurePanel} onSubmit={(event) => void submit(event)} aria-label="Try again with guidance">
      <h2 className={ds.sectionTitle}>Tell me what I got wrong and I&apos;ll try again.</h2>
      {summary ? <p>{summary}</p> : null}
      <ul className={ds.noteList}>{attempts.map((attempt) => <li key={attempt.id} className={ds.noteItem}>{describeAttempt(attempt)}</li>)}</ul>
      <label className={ds.field}>
        <span className={ds.label}>Your guidance (optional)</span>
        <textarea className={ds.textarea} value={guidance} onChange={(input) => setGuidance(input.target.value)} placeholder="For example: the amounts are in the 'Total' column, and I want one row per month." />
        <span className={tooLong ? ds.statusDanger : ds.counter}>{guidance.length.toLocaleString()} / {MAX_GUIDANCE_CHARS.toLocaleString()} characters</span>
      </label>
      {error ? (
        <div role="alert" className={ds.stackTight}>
          <p className={ds.statusDanger}>{error.message}</p>
          {error.consent ? <p className={ds.hint}>Review what is sent and approve it again by starting the task from {renderLink ? <Link to="/">New task</Link> : 'New task'}; the earlier approval no longer matches.</p> : null}
        </div>
      ) : null}
      <div className={ds.row}>
        <button type="submit" className={ds.btnPrimary} disabled={pending || tooLong}>{pending ? 'Starting…' : 'Try again'}</button>
        <button type="button" className={ds.btnGhost} disabled={pending} onClick={() => setDismissed(true)}>Not now</button>
      </div>
    </form>
  );
}
