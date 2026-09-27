import { useQueryClient } from '@tanstack/react-query';
import { ConversationView } from '../conversation/conversation-view';
import { ConnectionIndicator } from '../conversation/connection-indicator';
import { ExecutionStatusBadge } from '../conversation/execution-status-badge';
import { FailurePanel } from '../conversation/failure-panel';
import { CompletedSummary, RunControls } from '../conversation/run-controls';
import { WaitingBanner } from '../conversation/waiting-banner';
import { GenerationSection } from '../generation/generation-section';
import { GateSection } from '../verification/gate-section';
import { useExecutionStream } from '../../api/use-execution-stream';
import { ds } from '../../design-system/tokens';
import { RunRecordPanel } from './run-record-panel';

const CANCELLABLE = ['pending', 'generating', 'verifying'];
/** The existing conversation, generation, gate, review, and artifact views for one run. */
export function RunView({ taskId, executionId }: { taskId: string; executionId: number }) {
  const stream = useExecutionStream(executionId); const client = useQueryClient();
  return <section className={ds.cardStack}>
    <RunRecordPanel executionId={executionId} />
    <section className={ds.card}>
      <header className={ds.header}><h2 className={ds.sectionTitle}>Run {executionId}</h2><div className={ds.row}>{stream.execution ? <ExecutionStatusBadge status={stream.execution.status} /> : null}<ConnectionIndicator state={stream.connection} onRetry={stream.retry} /></div></header>
      {stream.error ? <p className={ds.statusDanger}>{stream.error}</p> : null}
      <div id="transcript"><ConversationView events={stream.events} executionId={executionId} /></div>
      {stream.execution ? <>
        {CANCELLABLE.includes(stream.execution.status) ? <RunControls execution={stream.execution} /> : null}
        <WaitingBanner execution={stream.execution} />
        <CompletedSummary execution={stream.execution} />
        {stream.execution.error ? <FailurePanel error={stream.execution.error} /> : null}
        <GenerationSection execution={stream.execution} events={stream.events} onRetried={() => void client.invalidateQueries({ queryKey: ['task', taskId] })} />
        <GateSection execution={stream.execution} events={stream.events} onRetried={() => void client.invalidateQueries({ queryKey: ['task', taskId] })} />
      </> : null}
    </section>
  </section>;
}
