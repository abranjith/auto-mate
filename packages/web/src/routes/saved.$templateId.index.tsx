import { useRef, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeColumnType, selectorLabel } from '@automate/core';
import { deleteTemplate, getTemplateRevision, useTemplate, useTemplateRuns } from '../api/template-queries';
import { HistoryItem } from '../components/history/history-item';
import { CodeFileView } from '../components/generation/code-file-view';
import { getExecution } from '../api/task-queries';
import { ds } from '../design-system/tokens';

function RevisionCode({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['template-revision', id], queryFn: () => getTemplateRevision(id), enabled: open });
  return <details className={ds.revisionItem} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Show the code</summary>
    {open && query.isPending ? <p>Loading code…</p> : null}
    {open && query.isError ? <p className={ds.statusDanger}>The code could not be loaded.</p> : null}
    {open && query.data ? query.data.files.map((file) => <CodeFileView key={file.path} file={file} />) : null}
  </details>;
}

function SourceRunLink({ executionId }: { executionId: number }) {
  const query = useQuery({ queryKey: ['execution', executionId], queryFn: () => getExecution(executionId) });
  return query.data ? <Link to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(query.data.taskId), executionId: String(executionId) }} className={ds.historyLink}>Saved from run {executionId}</Link> : <span className={ds.hint}>Saved from run {executionId}</span>;
}

function DeleteSavedTask({ id, name, revisions }: { id: number; name: string; revisions: number }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate(); const client = useQueryClient();
  const close = () => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); };
  const remove = async () => { setPending(true); setError(undefined); try {
    await deleteTemplate(id); await client.invalidateQueries({ queryKey: ['templates'] });
    client.removeQueries({ queryKey: ['template', id] });
    await navigate({ to: '/saved' });
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'The saved task could not be deleted.'); } finally { setPending(false); } };
  return <><button ref={trigger} type="button" className={ds.btnDanger} onClick={() => { setOpen(true); queueMicrotask(() => confirm.current?.focus()); }}>Delete saved task</button>
    {open ? <div role="dialog" aria-modal="true" aria-label="Delete saved task" className={ds.card} onKeyDown={(event) => { if (event.key === 'Escape') close(); }}><p>Delete '{name}' and its {revisions} revisions? Runs you made from it stay in History.</p>
      {error ? <p role="alert" className={ds.statusDanger}>{error}</p> : null}<div className={ds.row}><button ref={confirm} type="button" className={ds.btnDanger} disabled={pending} onClick={() => void remove()}>Delete saved task</button><button type="button" className={ds.btnGhost} onClick={close}>Cancel</button></div></div> : null}</>;
}

function SavedTaskDetail() {
  const { templateId } = Route.useParams(); const id = Number(templateId);
  const query = useTemplate(id); const runs = useTemplateRuns(id);
  if (query.isPending) return <p className={ds.statusMuted}>Loading saved task…</p>;
  if (query.isError || !query.data) return <p className={ds.statusDanger}>This saved task is no longer here.</p>;
  const { template, currentRevision: revision, revisions } = query.data;
  return <main className={ds.cardStack}><section className={ds.card}><h1 className={ds.title}>{template.name}</h1><p className={ds.historyPrompt}>{template.description}</p><p className={ds.hint}>Revision {revision.number} · {revision.contentDigestShort}</p><Link to="/saved/$templateId/run" params={{ templateId }} className={ds.historyLink}>Run with another file</Link></section>
    <section className={ds.card}><h2 className={ds.sectionTitle}>What it expects</h2>{revision.inputs.map((input) => <div key={input.position}><h3>File {input.position + 1}: {input.label} ({input.format === 'xlsx' ? 'Excel workbook' : 'CSV'})</h3>{input.tables.map((table, index) => <div key={index}><p>{selectorLabel(table.selector)}</p><table className={ds.contractTable}><thead><tr><th>Required column</th><th>Type</th></tr></thead><tbody>{table.columns.filter((column) => column.required).map((column) => <tr key={column.position}><td>{column.name}</td><td>{describeColumnType(column.declaredType ?? column.sourceType)}</td></tr>)}</tbody></table></div>)}</div>)}</section>
    <section className={ds.card}><h2 className={ds.sectionTitle}>What it produces</h2><ul className={ds.noteList}>{revision.declaredOutputs.map((output) => <li key={output.filename}>{output.title} — {output.filename} ({output.type})</li>)}</ul></section>
    <section className={ds.card}><h2 className={ds.sectionTitle}>Choices it remembers</h2><ul className={ds.ruleList}>{revision.rules.map((rule, index) => <li key={index}>{rule.question}: {rule.answer}</li>)}{revision.notes.map((note, index) => <li key={`note-${index}`}>{note.question}: {note.answer}</li>)}</ul>{!revision.rules.length && !revision.notes.length ? <p>No remembered choices.</p> : null}</section>
    <section className={ds.card}><h2 className={ds.sectionTitle}>Checked on</h2><p>{revision.runtimeLine}</p>{revision.readsWallClock.length ? <p className={ds.keepsNote}>This code reads the computer clock at {revision.readsWallClock.map((item) => `${item.path}:${item.line}`).join(', ')}. Choosing an as-of date may not control that read.</p> : null}</section>
    <section className={ds.card}><h2 className={ds.sectionTitle}>Revisions</h2><ul className={ds.savedList}>{revisions.map((item) => <li key={item.id} className={ds.revisionItem}>Revision {item.number} · {new Date(item.createdAt).toLocaleDateString()}{item.note ? <p>{item.note}</p> : null}{item.sourceExecutionId ? <SourceRunLink executionId={item.sourceExecutionId} /> : <p>From a task since deleted</p>}<RevisionCode id={item.id} /></li>)}</ul></section>
    <section className={ds.card}><h2 className={ds.sectionTitle}>Runs</h2>{runs.isPending ? <p>Loading runs…</p> : runs.data?.pages.flatMap((page) => page.items).length ? <ul className={ds.savedList}>{runs.data.pages.flatMap((page) => page.items).map((item) => <HistoryItem key={item.task.id} item={item} />)}</ul> : <p>No runs yet.</p>}{runs.hasNextPage ? <button type="button" className={ds.btnGhost} onClick={() => void runs.fetchNextPage()}>Load more</button> : null}</section>
    <DeleteSavedTask id={id} name={template.name} revisions={revisions.length} />
  </main>;
}
export const Route = createFileRoute('/saved/$templateId/')({ component: SavedTaskDetail });
