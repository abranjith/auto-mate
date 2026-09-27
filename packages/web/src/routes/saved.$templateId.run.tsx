import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ERROR_CODES, REUSE_NOTHING_SENT, renderMappingInstructions, type RepairMapping, type UploadResponse } from '@automate/core';
import { getCompatibility, startTemplateRepair, startTemplateRun, useTemplate } from '../api/template-queries';
import { SlotComposer } from '../components/saved/slot-composer';
import { AsOfField } from '../components/saved/as-of-field';
import { CompatibilityReport } from '../components/saved/compatibility-report';
import { MappingForm, initialMapping } from '../components/saved/mapping-form';
import { InstructionPreview } from '../components/saved/instruction-preview';
import { RepairReview } from '../components/saved/repair-review';
import { ds } from '../design-system/tokens';

function SavedRun() {
  const { templateId } = Route.useParams(); const id = Number(templateId);
  const template = useTemplate(id); const navigate = useNavigate();
  const [slots, setSlots] = useState<(UploadResponse | null)[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [mapping, setMapping] = useState<RepairMapping>({ columns: [], sheets: [], decisions: [], note: null });
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  /** Blocks a second Start before the first click's re-render disables the button. */
  const starting = useRef(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const inputCount = template.data?.currentRevision.inputs.length ?? 0;
  const uploadIds = useMemo(() => slots.slice(0, inputCount).map((slot) => slot?.upload.id ?? 0), [slots, inputCount]);
  const ready = inputCount > 0 && uploadIds.length === inputCount && uploadIds.every((uploadId) => uploadId > 0);
  const compatibility = useQuery({ queryKey: ['compatibility', id, uploadIds.join(','), date, zone], queryFn: () => getCompatibility(id, uploadIds, date ?? undefined, zone), enabled: ready });
  useEffect(() => { if (compatibility.data) setMapping(initialMapping(compatibility.data.report)); }, [compatibility.data?.digest]);
  if (template.isPending) return <p className={ds.statusMuted}>Loading saved task…</p>;
  if (!template.data) return <p className={ds.statusDanger}>This saved task is no longer here.</p>;
  const revision = template.data.currentRevision;
  const contract = { version: 1 as const, inputs: revision.inputs, rules: revision.rules, notes: revision.notes };
  const instructions = renderMappingInstructions(mapping, contract);
  const setSlot = (position: number, upload: UploadResponse | null) => setSlots((current) => { if (current[position]?.upload.id === upload?.upload.id) return current; const next = [...current]; next[position] = upload; return next; });
  const start = async () => { if (!compatibility.data || starting.current) return; starting.current = true; setPending(true); setError(undefined); try {
    const created = await startTemplateRun(id, { uploadIds, compatibilityDigest: compatibility.data.digest, asOf: compatibility.data.asOf });
    await navigate({ to: '/tasks/$taskId', params: { taskId: String(created.task.id) } });
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'The saved task could not start.'); if ((cause as { code?: string }).code === ERROR_CODES.COMPATIBILITY_STALE) void compatibility.refetch(); starting.current = false; } finally { setPending(false); } };
  const repair = async (consent: { consentId: number; payloadDigest: string }) => {
    const created = await startTemplateRepair(id, { uploadIds, mapping, consent, ...(date ? { asOfDate: date } : {}), timeZone: zone });
    await navigate({ to: '/tasks/$taskId', params: { taskId: String(created.task.id) } });
  };
  return <main className={ds.cardStack}><section className={ds.card}><h1 className={ds.title}>Run {template.data.template.name} with another file</h1><p>Revision {revision.number}</p></section>
    {revision.inputs.map((input) => <SlotComposer key={input.position} position={input.position} label={input.label} format={input.format} onChange={(upload) => setSlot(input.position, upload)} />)}
    <AsOfField date={date} onChange={setDate} zone={zone} />
    {!ready ? <p className={ds.hint}>Choose and analyze a file for every slot to see the fit check.</p> : compatibility.isPending ? <p>Checking the files…</p> : compatibility.isError ? <p role="alert" className={ds.statusDanger}>{compatibility.error.message}</p> : compatibility.data ? <><CompatibilityReport report={compatibility.data.report} />
      {compatibility.data.report.status === 'incompatible' || review ? <><MappingForm report={compatibility.data.report} uploads={slots} value={mapping} onChange={setMapping} /><InstructionPreview mapping={mapping} contract={contract} />
        {review ? <RepairReview uploadIds={uploadIds} instructions={instructions} decisions={Object.fromEntries(mapping.decisions.map(({ findingKey, answer }) => [findingKey, answer]))} onDecisionsChange={(choices) => setMapping((current) => ({ ...current, decisions: current.decisions.map((entry) => ({ ...entry, answer: choices[entry.findingKey] ?? entry.answer })) }))} onApproved={repair} onCancel={() => setReview(false)} /> : <button type="button" className={ds.btnPrimary} onClick={() => setReview(true)}>Continue to review</button>}</> : <><p className={ds.keepsNote}>{REUSE_NOTHING_SENT}</p><button type="button" className={ds.btnPrimary} disabled={pending} onClick={() => void start()}>{pending ? 'Starting…' : 'Start'}</button><button type="button" className={ds.btnGhost} onClick={() => setReview(true)}>Repair with AI instead</button></>}
    </> : null}
    {error ? <p role="alert" className={ds.statusDanger}>{error}</p> : null}
  </main>;
}
export const Route = createFileRoute('/saved/$templateId/run')({ component: SavedRun });
