import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getExecution } from '../api/task-queries';
import { RunView } from '../components/history/run-view';
import { ds } from '../design-system/tokens';

/** Stable URL for a specific run, checked against its parent task. */
function OneRun() {
  const { taskId, executionId } = Route.useParams();
  const run = useQuery({ queryKey: ['execution', Number(executionId)], queryFn: () => getExecution(Number(executionId)) });
  if (run.isPending) return <p className={ds.statusMuted}>Loading run…</p>;
  if (run.isError || !run.data) return <p className={ds.statusDanger}>This run is no longer here.</p>;
  if (run.data.taskId !== Number(taskId)) return <Navigate to="/tasks/$taskId" params={{ taskId: String(run.data.taskId) }} />;
  return <RunView taskId={taskId} executionId={Number(executionId)} />;
}
export const Route = createFileRoute('/tasks/$taskId/runs/$executionId/')({ component: OneRun });
