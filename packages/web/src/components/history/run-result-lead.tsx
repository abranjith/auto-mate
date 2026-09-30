import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { describeRunFailure, isSavedCodeRun, type ArtifactListResponse, type ConversationEvent, type ExecutionSummary, type RunRecord, type RunOutcomeInput } from '@automate/core';
import { getRunTimeline } from '../../api/history-queries';
import { getRun } from '../../api/verification-queries';
import { getAttempts } from '../../api/generation-queries';
import { ds } from '../../design-system/tokens';
import { ArtifactList } from '../artifacts/artifact-list';
import { needsOutcomePanel } from '../artifacts/no-outputs-panel';
import { AssistantMessage } from '../conversation/assistant-message';
import { joinAssistantText } from '../conversation/conversation-view';
import { isGenerationRun } from '../generation/generation-section';
import { SaveTaskDialog } from '../saved/save-task-dialog';
import { RunAgainButton } from './run-again-button';
import { RunOutcomePanel } from './run-outcome-panel';

const RESULT_STATUSES = new Set<ExecutionSummary['status']>(['completed', 'awaiting_review', 'failed', 'aborted', 'rejected']);

/** Lead a settled run with its outputs, final answer, and next action. */
export function RunResultLead({ execution, events, artifacts, record }: { execution: ExecutionSummary; events: readonly ConversationEvent[]; artifacts?: ArtifactListResponse; record?: RunRecord }) {
  const ran = events.some((event) => event.type === 'run_finished');
  const settled = [...events].reverse().find((event): event is Extract<ConversationEvent, { type: 'generation_settled' }> => event.type === 'generation_settled');
  const run = useQuery({ queryKey: ['script-run', execution.id], queryFn: () => getRun(execution.id), enabled: ran });
  const attempts = useQuery({ queryKey: ['generation-attempts', execution.id], queryFn: () => getAttempts(execution.id), enabled: !!settled });
  const latest = useQuery({ queryKey: ['run-timeline', execution.taskId, 'latest'], queryFn: () => getRunTimeline(execution.taskId), enabled: RESULT_STATUSES.has(execution.status) });
  if (!RESULT_STATUSES.has(execution.status)) return null;
  const reply = !isGenerationRun(events) && execution.status === 'completed' ? joinAssistantText([...events].sort((a, b) => a.seq - b.seq)).filter((event) => event.type === 'assistant_text').at(-1) : undefined;
  const canRetry = latest.data?.items[0]?.id === execution.id;
  const retry = canRetry && record ? <RunAgainButton taskId={execution.taskId} executionId={execution.id} uploadIds={record.inputs.map((input) => input.id)} savedCode={isSavedCodeRun(record.reuse?.kind)} /> : record?.chain.next.map((next) => <Link key={next.id} className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(execution.taskId), executionId: String(next.id) }}>Run {next.runNumber} came from this run</Link>);
  const missing = artifacts?.discrepancies.find((entry) => entry.kind === 'missing')?.count ?? 0;
  const scriptRun: RunOutcomeInput | null = run.data ? { status: run.data.status, exitCode: run.data.exitCode, limitBreached: run.data.limitBreached, manifestPresent: run.data.manifestPresent, declaredOutputCount: run.data.declaredOutputCount, missingDeclaredCount: missing } : null;
  const showOutcome = ['failed', 'aborted', 'rejected'].includes(execution.status) || !!run.data && needsOutcomePanel(run.data, artifacts);
  const failure = showOutcome ? describeRunFailure({ status: execution.status, errorCode: execution.error?.code ?? record?.execution.errorCode ?? null, errorMessage: execution.error?.message ?? record?.execution.errorMessage ?? null, correlationId: execution.error?.correlationId ?? null, scriptRun, artifacts: artifacts?.artifacts ?? [], checks: record?.checks ?? null, generation: settled ? { summary: settled.summary, attempts: attempts.data?.attempts ?? [] } : null, reviewFeedback: record?.personWords.reviewFeedback ?? null }) : null;
  return <section className={ds.resultLead} aria-label="Result"><h2 className={ds.sectionTitle}>Result</h2>
    {artifacts?.artifacts.length ? <ArtifactList list={artifacts} /> : null}
    {reply?.type === 'assistant_text' ? <section><h3 className={ds.sectionTitle}>Answer</h3><AssistantMessage text={reply.text} /></section> : null}
    {failure ? <RunOutcomePanel failure={failure} retry={retry} reviewing={execution.status === 'awaiting_review'} executionId={execution.id} artifacts={artifacts} /> : null}
    {execution.status === 'completed' ? <><SaveTaskDialog executionId={execution.id} />{!failure && retry ? <details className={ds.collapsible}><summary className={ds.collapsibleSummary}>Run it again</summary>{retry}</details> : null}</> : null}
  </section>;
}
