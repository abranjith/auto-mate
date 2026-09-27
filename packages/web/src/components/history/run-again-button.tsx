import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, Link } from '@tanstack/react-router';
import { AutoMateError, ERROR_CODES, MAX_GUIDANCE_CHARS, type DisclosurePreviewResponse } from '@automate/core';
import { useQueryClient } from '@tanstack/react-query';
import { getDisclosurePreview, grantDisclosureConsent } from '../../api/disclosure-queries';
import { retryExecution } from '../../api/generation-queries';
import { getTask } from '../../api/task-queries';
import { replayExecution } from '../../api/template-queries';
import { REPLAY_LIMITS } from '@automate/core';
import { DisclosureReviewPanel } from '../disclosure/disclosure-review-panel';
import { ds } from '../../design-system/tokens';

const needsConsent = (code: string): boolean => [ERROR_CODES.DISCLOSURE_CONSENT_STALE, ERROR_CODES.DISCLOSURE_CONSENT_REQUIRED, ERROR_CODES.DISCLOSURE_SCOPE_NOT_GRANTED].includes(code as typeof ERROR_CODES.DISCLOSURE_CONSENT_STALE);

/** Retry the latest terminal run and reopen the exact disclosure review when approval is stale. */
export function RunAgainButton({ taskId, executionId, uploadIds, savedCode = false }: { taskId: number; executionId: number; uploadIds: readonly number[]; savedCode?: boolean }) {
  const [guidance, setGuidance] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AutoMateError | null>(null);
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  const [preview, setPreview] = useState<DisclosurePreviewResponse>();
  /** A double click must not post two replays: state updates land only after both clicks. */
  const replaying = useRef(false);
  const navigate = useNavigate(); const client = useQueryClient();
  const replay = async () => { if (replaying.current) return; replaying.current = true; setPending(true); setError(null); try {
    const created = await replayExecution(executionId);
    await client.invalidateQueries({ queryKey: ['run-timeline', taskId] });
    await navigate({ to: '/tasks/$taskId/runs/$executionId', params: { taskId: String(taskId), executionId: String(created.execution.id) } });
  } catch (cause) { setError(cause instanceof AutoMateError ? cause : new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'The run could not be replayed.')); replaying.current = false; } finally { setPending(false); } };

  const refreshPreview = async () => {
    try { setPreview(await getDisclosurePreview(uploadIds)); setError(null); }
    catch (cause) { setError(cause instanceof AutoMateError ? cause : new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'The disclosure review could not be loaded.')); }
  };
  const start = async (decisions?: readonly { findingKey: string; choice: string }[]) => {
    if (pending || guidance.length > MAX_GUIDANCE_CHARS) return;
    setPending(true); setError(null); setOpenRunId(null);
    try {
      const created = await retryExecution(executionId, guidance, decisions);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['task', String(taskId)] }),
        client.invalidateQueries({ queryKey: ['run-timeline', taskId] }),
        client.invalidateQueries({ queryKey: ['history'] }),
      ]);
      await navigate({ to: '/tasks/$taskId/runs/$executionId', params: { taskId: String(taskId), executionId: String(created.execution.id) } });
    } catch (cause) {
      const failure = cause instanceof AutoMateError ? cause : new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'This run could not be started.');
      setError(failure);
      if (needsConsent(failure.code) && uploadIds.length) await refreshPreview();
      if (failure.code === ERROR_CODES.TASK_HAS_OPEN_RUN) {
        try { setOpenRunId((await getTask(taskId)).counts.openRunId); } catch { /* Keep the server's message. */ }
      }
    } finally { setPending(false); }
  };
  const approve = async ({ diagnostics, decisions }: { diagnostics: boolean; decisions: readonly { findingKey: string; choice: string }[] }) => {
    if (!preview || pending) return;
    setPending(true);
    try {
      await grantDisclosureConsent({ taskId, uploadIds: preview.uploadIds, payloadDigest: preview.digest, scopeDiagnostics: diagnostics });
      setPending(false);
      await start(decisions);
    } catch (cause) {
      setPending(false);
      setError(cause instanceof AutoMateError ? cause : new AutoMateError(ERROR_CODES.INTERNAL_ERROR, 'Approval could not be saved.'));
    }
  };
  if (preview) return <DisclosureReviewPanel preview={preview} pending={pending} error={error?.message} onApprove={(value) => void approve(value)} onRefresh={() => void refreshPreview()} onCancel={() => { setPreview(undefined); setError(null); }} />;
  if (savedCode) return <div className={ds.stackTight}><p className={ds.hint}>{REPLAY_LIMITS}</p><div className={ds.row}><button type="button" className={ds.btnPrimary} disabled={pending} onClick={() => void replay()}>{pending ? 'Starting…' : 'Run again exactly'}</button><Link className={ds.historyLink} to="/tasks/$taskId/runs/$executionId/repair" params={{ taskId: String(taskId), executionId: String(executionId) }}>Repair with AI</Link></div>{error ? <p role="alert" className={ds.statusDanger}>{error.message}</p> : null}</div>;
  return <form className={ds.stackTight} onSubmit={(event: FormEvent) => { event.preventDefault(); void start(); }}>
    <label className={ds.field}>Your guidance (optional)<textarea className={ds.textarea} value={guidance} maxLength={MAX_GUIDANCE_CHARS} onChange={(event) => setGuidance(event.target.value)} /></label>
    {error ? <p role="alert" className={ds.statusDanger}>{error.message}{openRunId ? <> <Link to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(taskId), executionId: String(openRunId) }}>Open that run</Link>.</> : null}</p> : null}
    <button className={ds.btnPrimary} disabled={pending || guidance.length > MAX_GUIDANCE_CHARS}>{pending ? 'Starting…' : 'Run again'}</button>
  </form>;
}
