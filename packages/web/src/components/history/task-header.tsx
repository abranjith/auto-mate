import { useRef, useState } from 'react';
import type { Task, TaskCounts } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { RelativeTime } from './relative-time';
import { DeleteTaskDialog } from './delete-task-dialog';
import { Link } from '@tanstack/react-router';
import type { RunTimelineItem } from '@automate/core';

/** Task name and its whole-task deletion control. */
export function TaskHeader({ task, counts, reuse }: { task: Task; counts: TaskCounts; reuse?: RunTimelineItem['reuse'] }) {
  const [open, setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null);
  return <header className={`${ds.card} ${ds.header}`}><div><h1 className={ds.title}>{task.name}</h1><p className={ds.hint}>Created <RelativeTime at={task.createdAt} /></p>{reuse ? <p>{reuse.templateId ? <>From your saved task <Link to="/saved/$templateId" params={{ templateId: String(reuse.templateId) }}>'{reuse.templateName}'</Link> (revision {reuse.revisionNumber})</> : <>From '{reuse.templateName}' (a saved task since deleted)</>}</p> : null}</div>
    <button ref={trigger} type="button" className={ds.btnDanger} onClick={() => setOpen(true)}>Delete task</button>
    {open ? <DeleteTaskDialog task={task} counts={counts} onClose={() => { setOpen(false); queueMicrotask(() => trigger.current?.focus()); }} /> : null}
  </header>;
}
