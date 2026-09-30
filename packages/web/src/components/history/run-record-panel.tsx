import { Link } from '@tanstack/react-router';
import { describeAsOf, describeCompatibilityStatus, describeRunState, formatDurationMs, isSavedCodeRun, type CompatibilityReport, type RunRecord } from '@automate/core';
import { useRunRecord } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';
import { RecordSection } from './record-section';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "3 questions · 2 answered by you · 1 carried over from an earlier run". */
function questionSummary(questions: NonNullable<RunRecord['questions']>): string {
  return [plural(questions.total, 'question'), questions.byPerson ? `${questions.byPerson} answered by you` : '', questions.seeded ? `${questions.seeded} carried over from an earlier run` : '', questions.defaulted ? `${questions.defaulted} used the proposed default` : '', questions.declined ? `${questions.declined} not asked` : '', questions.followUps ? plural(questions.followUps, 'follow-up') : ''].filter(Boolean).join(' · ');
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
  if (query.isPending) return <p className={ds.statusMuted}>Loading run record…</p>;
  if (!record) return <p className={ds.statusDanger}>This run record is no longer here.</p>;
  const { execution: run } = record; const state = describeRunState({ status: run.status, errorCode: run.errorCode });
  const savedRevision = record.reuse && isSavedCodeRun(record.reuse.kind) ? record.reuse.revisionNumber : undefined;
  return <section className={ds.card} aria-label="Run record"><h2 className={ds.sectionTitle}>How this run was made</h2>
    <p className={ds.statusMuted}>{state.label}</p>
    {record.reuse ? <RecordSection title="Saved task" summary={reuseSummary(record.reuse)} executionId={executionId} /> : null}
    <p className={ds.hint}>{record.asOf ? describeAsOf(record.asOf) : 'As of: not recorded (this run predates as-of dates)'}</p>
    {record.reuse?.instructions ? <pre className={ds.historyPrompt}>{record.reuse.instructions.join('\n')}</pre> : null}
    {record.personWords.guidance ? <p>Your guidance for this run: {record.personWords.guidance}</p> : null}
    {record.personWords.reviewFeedback ? <p>Your review: {record.personWords.reviewFeedback}</p> : null}
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
  </section>;
}
