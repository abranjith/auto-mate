import { useEffect, useRef, useState } from 'react';
import { describeRunState, isTerminal } from '@automate/core';
import { useQueryClient } from '@tanstack/react-query';
import { ConversationView } from '../conversation/conversation-view';
import { RunControls } from '../conversation/run-controls';
import { WaitingBanner } from '../conversation/waiting-banner';
import { GenerationSection } from '../generation/generation-section';
import { GateSection } from '../verification/gate-section';
import { useRunArtifacts } from '../verification/gate-section';
import { useExecutionStream } from '../../api/use-execution-stream';
import { useRunRecord } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';
import { RunRecordPanel } from './run-record-panel';
import { RunHeader } from './run-header';
import { TechnicalDetailsContext, useTechnicalDetails } from './use-technical-details';
import { RunResultLead } from './run-result-lead';

const CANCELLABLE = ['pending', 'generating', 'verifying'];
/** The existing conversation, generation, gate, review, and artifact views for one run. */
export function RunView({ taskId, executionId }: { taskId: string; executionId: number }) {
  const stream = useExecutionStream(executionId); const client = useQueryClient();
  // The same per-task number the Runs list shows, never the database id: "Run 2" must mean the second run.
  const record = useRunRecord(executionId).data;
  const runNumber = record?.execution.runNumber;
  const artifacts = useRunArtifacts(stream.execution, stream.events);
  const [technical, onTechnicalChange] = useTechnicalDetails();
  const terminal = stream.execution ? isTerminal(stream.execution.status) : false;
  const [transcriptOpen, setTranscriptOpen] = useState(() => window.location.hash === '#transcript' || !terminal);
  const openedByPerson = useRef(false);
  const transcriptRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { setTranscriptOpen(!terminal || openedByPerson.current || window.location.hash === '#transcript'); }, [terminal]);
  useEffect(() => {
    const openFromLink = () => {
      if (window.location.hash === '#transcript') { setTranscriptOpen(true); transcriptRef.current?.focus(); }
      if (window.location.hash === '#review') document.getElementById('review')?.focus();
    };
    window.addEventListener('hashchange', openFromLink);
    openFromLink();
    return () => window.removeEventListener('hashchange', openFromLink);
  }, []);
  return <TechnicalDetailsContext.Provider value={technical}><section className={ds.cardStack}>
    <RunHeader runNumber={runNumber} execution={stream.execution ?? undefined} connection={stream.connection} onRetryConnection={stream.retry} technical={technical} onTechnicalChange={onTechnicalChange} />
    <section className={ds.stack}>
      {stream.error ? <p className={ds.statusDanger}>{stream.error}</p> : null}
      {stream.execution ? <>
        {CANCELLABLE.includes(stream.execution.status) ? <RunControls execution={stream.execution} /> : null}
        <WaitingBanner execution={stream.execution} />
        <GenerationSection execution={stream.execution} events={stream.events} />
        <GateSection execution={stream.execution} events={stream.events} onRetried={() => void client.invalidateQueries({ queryKey: ['task', taskId] })} />
      </> : null}
    </section>
    {stream.execution ? <RunResultLead execution={stream.execution} events={stream.events} artifacts={artifacts} record={record} /> : null}
    <details id="run-record-details" className={ds.collapsible}><summary className={ds.collapsibleSummary}>How this run was made{record ? ` · ${describeRunState({ status: record.execution.status, errorCode: record.execution.errorCode }).label} · ${record.inputs.length} input files · ${record.outputs?.count ?? 0} outputs` : ''}</summary><RunRecordPanel executionId={executionId} /></details>
    <details ref={transcriptRef} id="transcript" tabIndex={-1} className={ds.collapsible} open={transcriptOpen}><summary className={ds.collapsibleSummary} onClick={(event) => { event.preventDefault(); openedByPerson.current = !transcriptOpen; setTranscriptOpen(!transcriptOpen); }}>Conversation</summary><ConversationView events={stream.events} executionId={executionId} /></details>
  </section></TechnicalDetailsContext.Provider>;
}
