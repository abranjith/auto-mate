import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getRunTimeline } from '../api/history-queries';
import { RunView } from '../components/history/run-view';
import { ds } from '../design-system/tokens';

/** `/tasks/:taskId` follows the latest run. */
function LatestRun() {
  const { taskId } = Route.useParams();
  const latest = useQuery({ queryKey: ['run-timeline', Number(taskId), 'latest'], queryFn: () => getRunTimeline(Number(taskId)) });
  if (latest.isPending) return <p className={ds.statusMuted}>Loading latest run…</p>;
  const run = latest.data?.items[0];
  return run ? <RunView taskId={taskId} executionId={run.id} /> : <p className={ds.statusDanger}>This task has no runs.</p>;
}
export const Route = createFileRoute('/tasks/$taskId/')({ component: LatestRun });
