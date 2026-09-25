import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ConversationView } from '../components/conversation/conversation-view';
import { ConnectionIndicator } from '../components/conversation/connection-indicator';
import { ExecutionStatusBadge } from '../components/conversation/execution-status-badge';
import { FailurePanel } from '../components/conversation/failure-panel';
import {
  CompletedSummary,
  RunControls,
} from '../components/conversation/run-controls';
import { useExecutionStream } from '../api/use-execution-stream';
import { getTask } from '../api/task-queries';
import { ds } from '../design-system/tokens';
import { WaitingBanner } from '../components/conversation/waiting-banner';
import { GenerationSection } from '../components/generation/generation-section';
/** Follow one execution using durable history plus its live tail. */
function LiveConversation({
  taskId,
  executionId,
}: {
  taskId: string;
  executionId: number;
}) {
  const stream = useExecutionStream(executionId);
  const client = useQueryClient();
  return (
    <section className={ds.cardStack}>
      <header className={ds.header}>
        <h1 className={ds.title}>Task {taskId}</h1>
        <div className={ds.row}>
          {stream.execution ? (
            <ExecutionStatusBadge status={stream.execution.status} />
          ) : null}
          <ConnectionIndicator
            state={stream.connection}
            onRetry={stream.retry}
          />
        </div>
      </header>
      {stream.error ? <p className={ds.statusDanger}>{stream.error}</p> : null}
      <ConversationView events={stream.events} executionId={executionId} />
      {stream.execution ? (
        <>
          {stream.execution.status === 'waiting' ? null : <RunControls execution={stream.execution} />}
          <WaitingBanner execution={stream.execution} />
          <CompletedSummary execution={stream.execution} />
          {stream.execution.error ? (
            <FailurePanel error={stream.execution.error} />
          ) : null}
          <GenerationSection
            execution={stream.execution}
            events={stream.events}
            onRetried={() => void client.invalidateQueries({ queryKey: ['task', taskId] })}
          />
        </>
      ) : null}
    </section>
  );
}
function TaskConversationPage() {
  const { taskId } = Route.useParams();
  const task = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => getTask(Number(taskId)),
  });
  if (task.isPending)
    return <p className={ds.statusMuted}>Loading conversation…</p>;
  const execution = task.data?.executions.at(-1);
  if (!execution)
    return <p className={ds.statusDanger}>This task has no execution.</p>;
  return <LiveConversation key={execution.id} taskId={taskId} executionId={execution.id} />;
}
export const Route = createFileRoute('/tasks/$taskId')({
  component: TaskConversationPage,
});
