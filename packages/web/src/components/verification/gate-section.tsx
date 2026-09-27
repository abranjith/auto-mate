import { useEffect, useState } from 'react';
import type { ApprovalRequest, ApprovalResponse, ArtifactListResponse, ConversationEvent, CreateTaskResponse, ExecutionSummary, ReviewRequest, ReviewResponse, RunIntentResponse, ScriptRun, VerificationReport as Report } from '@automate/core';
import { decideApproval, getIntent, getRun, getVerification, submitReview } from '../../api/verification-queries';
import { getArtifacts } from '../../api/artifact-queries';
import { retryExecution } from '../../api/generation-queries';
import { NoOutputsPanel, needsOutcomePanel } from '../artifacts/no-outputs-panel';
import { ds } from '../../design-system/tokens';
import { RunProgress } from '../execution/run-progress';
import { RunResult } from '../execution/run-result';
import { ReviewPanel } from '../review/review-panel';
import { RunIntentPanel } from './run-intent-panel';
import { VerificationReport } from './verification-report';

/** Server calls the gate makes; injectable for tests. */
export interface GateApi {
  readonly getVerification: (executionId: number) => Promise<Report>;
  readonly getIntent: (executionId: number) => Promise<RunIntentResponse>;
  readonly getRun: (executionId: number) => Promise<ScriptRun>;
  readonly decideApproval: (executionId: number, request: ApprovalRequest) => Promise<ApprovalResponse>;
  readonly submitReview: (executionId: number, request: ReviewRequest) => Promise<ReviewResponse>;
  /** FEAT-109: the run's registered outputs. */
  readonly getArtifacts: (executionId: number) => Promise<ArtifactListResponse>;
  /** FEAT-106's guidance retry, for a run that failed rather than one awaiting review. */
  readonly retry: (executionId: number, guidance: string) => Promise<CreateTaskResponse>;
}
const DEFAULT_API: GateApi = { getVerification, getIntent, getRun, decideApproval, submitReview, getArtifacts, retry: retryExecution };

/** Where a settled run's outcome panel is shown: while it waits for review, or once it failed or was stopped. */
const OUTCOME_STATUSES: readonly string[] = ['awaiting_review', 'failed', 'aborted'];

/** Load one resource whenever `key` changes; `undefined` until it arrives or when `enabled` is false. */
function useLoaded<T>(enabled: boolean, key: string, load: () => Promise<T>): [T | undefined, () => void] {
  const [value, setValue] = useState<T>();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((result) => { if (live) setValue(result); }, () => undefined);
    return () => { live = false; };
    // `load` is recreated each render on purpose: `key` and `nonce` alone decide when to fetch.
  }, [enabled, key, nonce]);
  return [enabled ? value : undefined, () => setNonce((current) => current + 1)];
}

const count = (events: readonly ConversationEvent[], type: ConversationEvent['type']) => events.filter((event) => event.type === type).length;

/**
 * FEAT-107's part of a run: the check report, the approval gate, the run in
 * progress, its result, and the review — each shown only when it applies.
 */
export function GateSection({ execution, events, onRetried, api = DEFAULT_API, now: fixedNow }: { execution: ExecutionSummary; events: readonly ConversationEvent[]; onRetried?: (retryExecutionId: number) => void; api?: GateApi; now?: number }) {
  const status = execution.status;
  const verified = count(events, 'verification_finished');
  const ran = count(events, 'run_finished');
  const [report] = useLoaded(verified > 0, `${execution.id}:${verified}:${status}`, () => api.getVerification(execution.id));
  const [intent, refreshIntent] = useLoaded(status === 'awaiting_approval', `${execution.id}:${verified}`, () => api.getIntent(execution.id));
  const [run] = useLoaded(ran > 0, `${execution.id}:${ran}:${status}`, () => api.getRun(execution.id));
  const registered = count(events, 'artifacts_registered');
  const [artifacts] = useLoaded(ran > 0, `${execution.id}:${ran}:${registered}:${status}`, () => api.getArtifacts(execution.id));
  // Retry with the person's words through the control that exists for this status.
  const retryWith = async (detail: string) => {
    if (status === 'awaiting_review') {
      const response = await api.submitReview(execution.id, { verdict: 'rejected', feedback: detail });
      if (response.retryExecutionId !== null) onRetried?.(response.retryExecutionId);
      return;
    }
    const created = await api.retry(execution.id, detail);
    onRetried?.(created.execution.id);
  };
  const [now, setNow] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (status !== 'executing' || fixedNow !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status, fixedNow]);
  if (verified === 0 && status !== 'verifying') return null;
  return (
    <div className={ds.stack}>
      {status === 'verifying' ? <p className={ds.runProgress} role="status">Checking the code…</p> : null}
      {report ? <VerificationReport report={report} /> : null}
      {status === 'awaiting_approval' && intent ? <RunIntentPanel key={intent.intentDigest} data={intent} onStale={refreshIntent} onDecide={(decision, acknowledgedWarnings) => api.decideApproval(execution.id, { intentDigest: intent.intentDigest, decision, acknowledgedWarnings })} /> : null}
      {status === 'executing' ? <RunProgress execution={execution} now={now} /> : null}
      {run && status !== 'executing' ? <RunResult run={run} {...(artifacts ? { artifacts } : {})} /> : null}
      {run && OUTCOME_STATUSES.includes(status) && needsOutcomePanel(run, artifacts) ? <NoOutputsPanel run={run} artifacts={artifacts} onRetry={retryWith} /> : null}
      {status === 'awaiting_review' ? <div id="review"><ReviewPanel onReview={(verdict, feedback) => api.submitReview(execution.id, { verdict, ...(feedback === undefined ? {} : { feedback }) })} savedCode={events.some((event) => event.type === 'reuse_started')} taskId={execution.taskId} executionId={execution.id} {...(onRetried ? { onRetried } : {})} /></div> : null}
    </div>
  );
}
