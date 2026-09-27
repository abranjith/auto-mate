import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { AutoMateError, ERROR_CODES, type Task, type TaskCounts } from '@automate/core';
import { useQueryClient } from '@tanstack/react-query';
import { useAbortExecution } from '../../api/task-queries';
import { useDeleteTask } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';

/** Confirm a complete task deletion and explain a currently open run. */
export function DeleteTaskDialog({ task, counts, onClose }: { task: Task; counts: TaskCounts; onClose(): void }) {
  const keep = useRef<HTMLButtonElement>(null); const [message, setMessage] = useState(''); const navigate = useNavigate(); const client = useQueryClient();
  const submitted = useRef(false);
  const deletion = useDeleteTask(task.id); const abort = useAbortExecution(counts.openRunId ?? 0);
  useEffect(() => {
    const root = document.getElementById('root'); if (root) root.inert = true;
    keep.current?.focus();
    return () => { if (root) root.inert = false; };
  }, []);
  const finish = (pending = 0) => { const notice = pending ? "Task deleted. Some files are open in another program. They'll be removed the next time the app starts." : 'Task deleted.'; setMessage(notice); sessionStorage.setItem('automate:history-announcement', notice); client.removeQueries({ queryKey: ['task', String(task.id)] }); void client.invalidateQueries({ queryKey: ['history'] }); void navigate({ to: '/history' }); };
  const remove = () => {
    if (submitted.current) return;
    submitted.current = true;
    deletion.mutate(undefined, { onSuccess: (value) => finish(value.filesPendingRemoval), onError: (error) => { if (error instanceof AutoMateError && error.code === ERROR_CODES.TASK_NOT_FOUND) finish(); else submitted.current = false; } });
  };
  const cancelRun = () => abort.mutate(undefined, { onSuccess: () => { void client.invalidateQueries({ queryKey: ['task', String(task.id)] }); } });
  return createPortal(<div className={ds.dialogBackdrop} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
    <div role="alertdialog" aria-labelledby="delete-title" aria-describedby="delete-description" className={ds.dialogPanel}>
      <h2 id="delete-title" className={ds.sectionTitle}>Delete {task.name}?</h2>
      <p id="delete-description">This removes {counts.runs} runs, {counts.inputs} input files, and {counts.outputs} outputs from this computer, including everything that was sent to the AI and every version of the code. This can&apos;t be undone.</p>
      {counts.savedAs?.map((name) => <p key={name} className={ds.keepsNote}>This task was saved as &apos;{name}&apos;. The saved task keeps its own copy of the code and column names and is not deleted.</p>)}
      {counts.openRunId ? <p className={ds.hint}>Run {counts.openRunId} is still open. Cancel or finish it before deleting the task.</p> : null}
      {deletion.isError && !(deletion.error instanceof AutoMateError && deletion.error.code === ERROR_CODES.TASK_NOT_FOUND) ? <p role="alert" className={ds.statusDanger}>{deletion.error.message}</p> : null}
      {abort.isError ? <p role="alert" className={ds.statusDanger}>{abort.error.message}</p> : null}
      <div className={ds.row}><button ref={keep} className={ds.btnGhost} onClick={onClose}>Keep task</button>{counts.openRunId ? <button className={ds.btnGhost} disabled={abort.isPending} onClick={cancelRun}>Cancel that run</button> : <button className={ds.btnDanger} disabled={deletion.isPending} onClick={remove}>Delete task</button>}</div>
      <span aria-live="polite" className={ds.srOnly}>{message}</span>
    </div>
  </div>, document.body);
}
