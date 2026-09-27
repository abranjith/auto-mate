import { useEffect, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { renderMappingInstructions, type InputContract, type RepairMapping } from '@automate/core';
import { useRunRecord } from '../api/history-queries';
import { useTaskUploads } from '../api/upload-mutations';
import { getExecutionCompatibility, repairExecution, useTemplate } from '../api/template-queries';
import { CompatibilityReport } from '../components/saved/compatibility-report';
import { MappingForm, initialMapping } from '../components/saved/mapping-form';
import { RepairReview } from '../components/saved/repair-review';
import { InstructionPreview } from '../components/saved/instruction-preview';
import { ds } from '../design-system/tokens';

const EMPTY_CONTRACT: InputContract = { version: 1, inputs: [], rules: [], notes: [] };
function RepairRun() {
  const { taskId, executionId } = Route.useParams(); const id = Number(executionId); const task = Number(taskId);
  const record = useRunRecord(id); const uploads = useTaskUploads(task);
  const template = useTemplate(record.data?.reuse?.templateId ?? 0);
  const check = useQuery({ queryKey: ['execution-compatibility', id], queryFn: () => getExecutionCompatibility(id), enabled: Boolean(record.data?.reuse?.templateId), retry: false });
  const [mapping, setMapping] = useState<RepairMapping>({ columns: [], sheets: [], decisions: [], note: null });
  const [review, setReview] = useState(false); const [error, setError] = useState<string>();
  const navigate = useNavigate();
  useEffect(() => { if (check.data) setMapping({ ...initialMapping(check.data.report), note: record.data?.personWords.reviewFeedback ?? null }); else if (record.data?.personWords.reviewFeedback) setMapping((value) => ({ ...value, note: record.data!.personWords.reviewFeedback })); }, [check.data?.digest, record.data?.personWords.reviewFeedback]);
  if (record.isPending || uploads.isPending) return <p>Loading repair options…</p>;
  if (!record.data?.reuse || !uploads.data) return <p className={ds.statusDanger}>This run cannot be repaired from here.</p>;
  const contract = template.data ? { version: 1 as const, inputs: template.data.currentRevision.inputs, rules: template.data.currentRevision.rules, notes: template.data.currentRevision.notes } : EMPTY_CONTRACT;
  const instructions = renderMappingInstructions(mapping, contract);
  const uploadIds = uploads.data.uploads.map((upload) => upload.upload.id);
  const start = async (consent: { consentId: number; payloadDigest: string }) => { try {
    const created = await repairExecution(id, { ...(check.data ? { mapping } : {}), consent, note: mapping.note ?? undefined });
    await navigate({ to: '/tasks/$taskId/runs/$executionId', params: { taskId, executionId: String(created.execution.id) } });
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'The repair could not start.'); throw cause; } };
  return <section className={ds.cardStack}><section className={ds.card}><h2 className={ds.sectionTitle}>Repair with AI</h2><p>Your file description and these instructions will be sent to the AI after you approve them. The saved code is not included in the prompt.</p></section>
    {check.data ? <><CompatibilityReport report={check.data.report} /><MappingForm report={check.data.report} uploads={uploads.data.uploads} value={mapping} onChange={setMapping} /><InstructionPreview mapping={mapping} contract={contract} /></> : <label className={ds.field}>What should the AI change?<textarea className={ds.textarea} value={mapping.note ?? ''} onChange={(event) => setMapping({ ...mapping, note: event.target.value || null })} /></label>}
    {review ? <RepairReview uploadIds={uploadIds} instructions={instructions} taskId={task} onApproved={start} onCancel={() => setReview(false)} /> : <button type="button" className={ds.btnPrimary} disabled={!mapping.note && !mapping.columns.length && !mapping.sheets.length && !mapping.decisions.length} onClick={() => setReview(true)}>Continue to review</button>}
    {error ? <p role="alert" className={ds.statusDanger}>{error}</p> : null}
  </section>;
}
export const Route = createFileRoute('/tasks/$taskId/runs/$executionId/repair')({ component: RepairRun });
