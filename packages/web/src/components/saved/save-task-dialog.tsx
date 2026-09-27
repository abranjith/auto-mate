import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SAVED_TASK_KEEPS } from '@automate/core';
import { getSavePreview, saveExecution } from '../../api/template-queries';
import { ds } from '../../design-system/tokens';

/** Save a person-accepted run after showing its retained metadata. */
export function SaveTaskDialog({ executionId }: { executionId: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [newTask, setNewTask] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  const preview = useQuery({ queryKey: ['save-preview', executionId], queryFn: () => getSavePreview(executionId) });
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  const close = () => { setOpen(false); setError(undefined); trigger.current?.focus(); };
  const save = async () => {
    if (busy.current || !preview.data?.saveable) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const target = preview.data.promoteTarget;
      const result = await saveExecution(executionId, { name: name.trim() || preview.data.defaultName, ...(target && !newTask ? { templateId: target.templateId } : {}) });
      await client.invalidateQueries({ queryKey: ['templates'] });
      await client.invalidateQueries({ queryKey: ['save-preview', executionId] });
      await navigate({ to: '/saved/$templateId', params: { templateId: String(result.template.id) } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The task could not be saved.'); busy.current = false; setPending(false); }
  };
  if (preview.data?.alreadySaved) return <p>Saved as <Link to="/saved/$templateId" params={{ templateId: String(preview.data.alreadySaved.templateId) }}>{preview.data.alreadySaved.name}</Link> (revision {preview.data.alreadySaved.revisionNumber}).</p>;
  if (preview.data && !preview.data.saveable) return <p className={ds.hint}>{preview.data.reason}</p>;
  return <><button ref={trigger} type="button" className={ds.btnGhost} disabled={preview.isPending} onClick={() => { setName(preview.data?.defaultName ?? ''); setOpen(true); }}>Save this task</button>
    {open && preview.data ? <div role="dialog" aria-modal="true" aria-label="Save this task" className={ds.card} onKeyDown={(event) => { if (event.key === 'Escape') close(); }}>
      <h2 className={ds.sectionTitle}>Save this task</h2>
      <label className={ds.field}>Name<input ref={field} className={ds.input} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      <h3>What will be kept</h3>
      <ul className={ds.noteList}>{preview.data.keeps.inputs.map((input, index) => <li key={index}>{input.label} ({input.format}){input.sheets.length ? ` · sheets: ${input.sheets.join(', ')}` : ''}{input.requiredColumns.length ? ` · required columns: ${input.requiredColumns.join(', ')}` : ''}</li>)}</ul>
      <p>{preview.data.keeps.ruleCount} remembered choices · {preview.data.keeps.noteCount} notes</p>
      <p className={ds.keepsNote}>{SAVED_TASK_KEEPS}</p>
      {preview.data.readsWallClock.length ? <p className={ds.statusDanger}>This code reads the computer clock at {preview.data.readsWallClock.map((item) => `${item.path}:${item.line}`).join(', ')}. Choosing an as-of date may not control that read.</p> : null}
      {preview.data.promoteTarget ? <label className={ds.checkboxRow}><input type="checkbox" checked={newTask} onChange={(event) => setNewTask(event.target.checked)} /> Save as a new saved task</label> : null}
      {error ? <p role="alert" className={ds.statusDanger}>{error}</p> : null}
      <div className={ds.row}><button type="button" className={ds.btnPrimary} disabled={pending || !name.trim()} onClick={() => void save()}>{pending ? 'Saving…' : preview.data.promoteTarget && !newTask ? `Save as revision ${preview.data.promoteTarget.nextRevisionNumber} of '${preview.data.promoteTarget.name}'` : 'Save task'}</button><button type="button" className={ds.btnGhost} onClick={close}>Cancel</button></div>
    </div> : null}</>;
}
