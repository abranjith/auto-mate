import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { describeAsOf, describeCompatibilityStatus, describeRunState, ERROR_CODES, formatDurationMs, INTERRUPTION_MESSAGES, isSavedCodeRun, isTerminal, type CompatibilityReport, type RunRecord } from '@automate/core';
import { getTask } from '../../api/task-queries';
import { getRunTimeline, useRunRecord } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';
import { RecordSection } from './record-section';
import { RunAgainButton } from './run-again-button';
import { SaveTaskDialog } from '../saved/save-task-dialog';

/** Runs that stopped because the app restarted or closed: their explanation leads, and Run again follows. */
const STOPPED_BY_APP: readonly string[] = [ERROR_CODES.EXECUTION_INTERRUPTED, ERROR_CODES.EXECUTION_STOPPED_ON_SHUTDOWN];
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "3 questions · 2 answered by you · 1 carried over from an earlier run". */
function questionSummary(questions: NonNullable<RunRecord['questions']>): string {
  return [plural(questions.total, 'question'), questions.byPerson ? `${questions.byPerson} answered by you` : '', questions.seeded ? `${questions.seeded} carried over from an earlier run` : '', questions.defaulted ? `${questions.defaulted} used the proposed default` : '', questions.declined ? `${questions.declined} not asked` : ''].filter(Boolean).join(' · ');
}

/** "Monthly sales · revision 2 · 3f9a… · This file fits, with warnings to review (1 warning)". */
function reuseSummary(reuse: NonNullable<RunRecord['reuse']>): string {
  const fit = reuse.compatibility ? `${describeCompatibilityStatus(reuse.compatibility.status as CompatibilityReport['status'])}${reuse.compatibility.advisoryCount ? ` (${plural(reuse.compatibility.advisoryCount, 'warning')})` : ''}` : '';
  return [reuse.templateName, `revision ${reuse.revisionNumber}`, reuse.revisionDigestShort, fit].filter(Boolean).join(' · ');
}

/** Browser-safe provenance overview for a run; full detail remains in owning views. */
export function RunRecordPanel({ executionId }: { executionId: number }) {
  const query = useRunRecord(executionId); const record = query.data;
  const taskId = record?.execution.taskId ?? 0;
  const task = useQuery({ queryKey: ['task', String(taskId)], queryFn: () => getTask(taskId), enabled: taskId > 0 });
  const latest = useQuery({ queryKey: ['run-timeline', taskId, 'latest'], queryFn: () => getRunTimeline(taskId), enabled: taskId > 0 });
  if (query.isPending) return <p className={ds.statusMuted}>Loading run record…</p>;
  if (!record) return <p className={ds.statusDanger}>This run record is no longer here.</p>;
  const { execution: run } = record; const state = describeRunState({ status: run.status, errorCode: run.errorCode });
  const canRetry = isTerminal(run.status) && latest.data?.items[0]?.id === run.id;
  const stoppedByApp = run.errorCode !== null && STOPPED_BY_APP.includes(run.errorCode);
  const savedRevision = record.reuse && isSavedCodeRun(record.reuse.kind) ? record.reuse.revisionNumber : undefined;
  const runAgain = canRetry ? <RunAgainButton taskId={taskId} executionId={executionId} uploadIds={record.inputs.map((input) => input.id)} savedCode={isSavedCodeRun(record.reuse?.kind)} /> : null;
  return <section className={ds.card} aria-label="Run record"><h2 className={ds.sectionTitle}>Run record</h2>
    {stoppedByApp ? <><p>{run.errorMessage ?? INTERRUPTION_MESSAGES.waiting}</p>{runAgain}</> : null}
    <p className={ds.statusMuted}>{state.label}</p>
    {record.reuse ? <RecordSection title="Saved task" summary={reuseSummary(record.reuse)} executionId={executionId} /> : null}
    <p className={ds.hint}>{record.asOf ? describeAsOf(record.asOf) : 'As of: not recorded (this run predates as-of dates)'}</p>
    {record.reuse?.instructions ? <pre className={ds.historyPrompt}>{record.reuse.instructions.join('\n')}</pre> : null}
    <RecordSection title="What you asked" summary={task.data?.task.description ?? 'The original request'} executionId={executionId} />
    {record.personWords.guidance ? <p>You said: {record.personWords.guidance}</p> : null}
    {record.personWords.reviewFeedback ? <p>You said: {record.personWords.reviewFeedback}</p> : null}
    {record.inputs.length ? <RecordSection title="Files" summary={`${plural(record.inputs.length, 'input file')}${record.inputsReadByRun ? ' · The run read exactly these files' : ''}`} executionId={executionId} /> : null}
    {record.disclosure ? <RecordSection title="What was sent" summary={`${plural(record.disclosure.sendCount, 'send')} to ${record.disclosure.provider ?? 'the provider'}${record.disclosure.model ? ` (${record.disclosure.model})` : ''}`} executionId={executionId} detail="disclosure" /> : null}
    {record.questions ? <RecordSection title="Questions" summary={questionSummary(record.questions)} executionId={executionId} detail="questions" /> : null}
    {record.code ? <RecordSection title="Code" summary={`${savedRevision === undefined ? `Attempt ${record.code.attempt}` : `From saved task revision ${savedRevision}`} · ${record.code.shortDigest}${record.code.testsPassed === null ? '' : record.code.testsPassed ? ' · its own tests passed' : ' · its own tests failed'}`} executionId={executionId} detail="code" resourceId={record.code.id} {...(savedRevision === undefined ? {} : { savedRevisionNumber: savedRevision })} /> : null}
    {record.checks ? <RecordSection title="Checks" summary={[record.checks.summary, record.checks.runtime].filter(Boolean).join(' · ')} executionId={executionId} detail="checks" /> : null}
    {record.approval ? <RecordSection title="Approval" summary={`Approved ${new Date(record.approval.decidedAt).toLocaleString()}${record.approval.acknowledgedWarnings ? ' · you acknowledged the warnings' : ''}`} executionId={executionId} /> : null}
    {record.scriptRun ? <RecordSection title="Run" summary={[record.scriptRun.status, record.scriptRun.durationMs === null ? '' : formatDurationMs(record.scriptRun.durationMs), record.scriptRun.limitBreach ?? ''].filter(Boolean).join(' · ')} executionId={executionId} detail="run" /> : <RecordSection title="Run" summary={state.label} executionId={executionId} />}
    {record.outputs ? <RecordSection title="Outputs" summary={plural(record.outputs.count, 'output')} executionId={executionId} detail="outputs" /> : null}
    {record.chain.previous ? <Link className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(taskId), executionId: String(record.chain.previous.id) }}>Came from run {record.chain.previous.runNumber}</Link> : null}
    {record.chain.next.map((next) => <Link key={next.id} className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(taskId), executionId: String(next.id) }}>Led to run {next.runNumber}</Link>)}
    {stoppedByApp ? null : runAgain}
    {run.status === 'completed' ? <SaveTaskDialog executionId={executionId} /> : null}
  </section>;
}
