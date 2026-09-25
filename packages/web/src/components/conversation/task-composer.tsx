import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AutoMateError, ERROR_CODES, type CreateTaskRequest, type DisclosurePreviewResponse, type PreflightDecision } from '@automate/core';
import { getDisclosurePreview, grantDisclosureConsent } from '../../api/disclosure-queries';
import { useCreateTask } from '../../api/task-queries';
import { ds } from '../../design-system/tokens';
import { DisclosureReviewPanel } from '../disclosure/disclosure-review-panel';
import { FileDropZone } from '../ingestion/file-drop-zone';
import { UploadList } from '../ingestion/upload-list';
import { useAttachments } from '../ingestion/use-attachments';

function errorMessage(error: unknown): string {
  if (error instanceof AutoMateError && error.code === ERROR_CODES.EXECUTION_LIMIT_REACHED) return 'Another task is already running. Wait for it to finish, or cancel it.';
  if (error instanceof AutoMateError) return error.message;
  return 'The task could not be started. Try again.';
}

/** Plain-language task entry with an explicit disclosure gate for attachments. */
export function TaskComposer() {
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<DisclosurePreviewResponse>();
  const [previewPending, setPreviewPending] = useState(false);
  const [gateError, setGateError] = useState<string>();
  const attachments = useAttachments();
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const mutation = useCreateTask();
  const navigate = useNavigate();
  useEffect(() => input.current?.focus(), []);

  const startTask = (body: CreateTaskRequest) => mutation.mutate(body, {
    onSuccess: ({ task }) => { attachments.clear(); void navigate({ to: '/tasks/$taskId', params: { taskId: String(task.id) } } as never); },
    onError: () => { submitting.current = false; },
  });
  const loadPreview = async () => {
    setPreviewPending(true);
    setGateError(undefined);
    try { setPreview(await getDisclosurePreview(attachments.uploadIds)); }
    catch (error) { setGateError(errorMessage(error)); }
    finally { setPreviewPending(false); }
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || mutation.isPending || submitting.current || attachments.busy) return;
    if (attachments.uploadIds.length > 0) { void loadPreview(); return; }
    submitting.current = true;
    startTask({ prompt: trimmed });
  };
  const approve = async ({ diagnostics, decisions }: { diagnostics: boolean; decisions: readonly PreflightDecision[] }) => {
    if (!preview || submitting.current) return;
    submitting.current = true;
    setGateError(undefined);
    try {
      const consent = await grantDisclosureConsent({ uploadIds: preview.uploadIds, payloadDigest: preview.digest, scopeDiagnostics: diagnostics });
      startTask({ prompt: prompt.trim(), uploadIds: preview.uploadIds, disclosureAck: { consentId: consent.id, payloadDigest: consent.payloadDigest }, preflightDecisions: [...decisions] });
    } catch (error) { submitting.current = false; setGateError(errorMessage(error)); }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); } };

  if (preview) return <DisclosureReviewPanel preview={preview} pending={mutation.isPending || submitting.current} error={gateError} onApprove={approve} onRefresh={() => void loadPreview()} onCancel={() => { setPreview(undefined); setGateError(undefined); }} />;
  return <form className={ds.composer} onSubmit={submit}>
    <label className={ds.label} htmlFor="task-prompt">What would you like Auto-Mate to do?</label>
    <textarea id="task-prompt" ref={input} className={ds.textarea} rows={6} maxLength={8000} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={keyDown} placeholder="Describe the result you want in plain language…" />
    <FileDropZone existingCount={attachments.items.length} onAccept={attachments.add} disabled={mutation.isPending} />
    <UploadList items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />
    {prompt.length >= 7600 ? <span className={ds.counter}>{prompt.length} / 8000</span> : null}
    {mutation.isError || gateError ? <p className={ds.statusDanger} role="alert">{gateError ?? errorMessage(mutation.error)}</p> : null}
    <div className={ds.row}><button className={ds.btnPrimary} type="submit" disabled={!prompt.trim() || mutation.isPending || attachments.busy || previewPending}>{mutation.isPending ? 'Starting…' : previewPending ? 'Preparing review…' : 'Start task'}</button>{attachments.busy ? <span className={ds.hint}>Waiting for files to finish…</span> : null}<span className={ds.hint}>Ctrl/Cmd + Enter</span></div>
  </form>;
}
