import { createFileRoute, Outlet, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getTask } from '../api/task-queries';
import { ds } from '../design-system/tokens';
import { TaskHeader } from '../components/history/task-header';
import { LineageRail } from '../components/history/lineage-rail';
import { TaskInputs } from '../components/history/task-inputs';
import { useRunTimeline } from '../api/history-queries';

/** Task header, original request, inputs, and the navigable run timeline. */
function TaskPage() {
  const { taskId } = Route.useParams();
  const { executionId } = useParams({ strict: false });
  const id = Number(taskId);
  const task = useQuery({ queryKey: ['task', taskId], queryFn: () => getTask(id) });
  const timeline = useRunTimeline(id);
  const reuse = timeline.data?.pages.flatMap((page) => page.items).find((item) => item.reuse)?.reuse;
  if (task.isPending) return <p className={ds.statusMuted}>Loading task…</p>;
  if (task.isError || !task.data) return <p className={ds.statusDanger}>This task was deleted or never existed. <a href="/history" className={ds.historyLink}>Back to History</a></p>;
  return <div className={ds.cardStack}>
    <TaskHeader task={task.data.task} counts={task.data.counts} reuse={reuse} />
    <section className={ds.card}><h2 className={ds.sectionTitle}>What you asked</h2><p className={ds.historyPrompt}>{task.data.task.description}</p></section>
    <TaskInputs taskId={id} />
    <LineageRail taskId={id} currentExecutionId={executionId ? Number(executionId) : undefined} />
    <Outlet />
  </div>;
}

export const Route = createFileRoute('/tasks/$taskId')({ component: TaskPage });
