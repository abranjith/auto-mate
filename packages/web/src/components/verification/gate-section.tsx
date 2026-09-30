import { useEffect, useState } from 'react';
import type { ApprovalRequest, ApprovalResponse, ArtifactListResponse, ConversationEvent, ExecutionSummary, ReviewRequest, ReviewResponse, RunIntentResponse, VerificationReport as Report } from '@automate/core';
import { decideApproval, getIntent, getVerification, submitReview } from '../../api/verification-queries';
import { getArtifacts } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';
import { RunProgress } from '../execution/run-progress';
import { ReviewPanel } from '../review/review-panel';
import { RunIntentPanel } from './run-intent-panel';
import { VerificationReport } from './verification-report';

/** Server calls the gate makes; injectable for tests. */
export interface GateApi {
  readonly getVerification: (executionId: number) => Promise<Report>;
  readonly getIntent: (executionId: number) => Promise<RunIntentResponse>;
  readonly decideApproval: (executionId: number, request: ApprovalRequest) => Promise<ApprovalResponse>;
  readonly submitReview: (executionId: number, request: ReviewRequest) => Promise<ReviewResponse>;
}
const DEFAULT_API: GateApi = { getVerification, getIntent, decideApproval, submitReview };


/** Load one resource whenever `key` changes; `undefined` until it arrives or when `enabled` is false. */
function useLoaded<T>(enabled: boolean, key: string, load: () => Promise<T>): [T | undefined, () => void] {
  const [loaded, setLoaded] = useState<{ key: string; value: T }>();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((result) => { if (live) setLoaded({ key, value: result }); }, () => undefined);
    return () => { live = false; };
    // `load` is recreated each render on purpose: `key` and `nonce` alone decide when to fetch.
  }, [enabled, key, nonce]);
  return [enabled && loaded?.key === key ? loaded.value : undefined, () => setNonce((current) => current + 1)];
}

const count = (events: readonly ConversationEvent[], type: ConversationEvent['type']) => events.filter((event) => event.type === type).length;

/** Load registered outputs after a run settles, and again after a later registration receipt. */
export function useRunArtifacts(execution: ExecutionSummary | null | undefined, events: readonly ConversationEvent[]): ArtifactListResponse | undefined {
  const ran = count(events, 'run_finished');
  const registered = count(events, 'artifacts_registered');
  const [artifacts] = useLoaded(!!execution && ran > 0, `${execution?.id}:${ran}:${registered}`, () => getArtifacts(execution!.id));
  return artifacts;
}

/**
 * FEAT-107's part of a run: the check report, the approval gate, the run in
 * progress, its result, and the review — each shown only when it applies.
 */
export function GateSection({ execution, events, onRetried, api = DEFAULT_API, now: fixedNow }: { execution: ExecutionSummary; events: readonly ConversationEvent[]; onRetried?: (retryExecutionId: number) => void; api?: GateApi; now?: number }) {
  const status = execution.status;
  const verified = count(events, 'verification_finished');
  const [report] = useLoaded(verified > 0, `${execution.id}:${verified}:${status}`, () => api.getVerification(execution.id));
  const [intent, refreshIntent] = useLoaded(status === 'awaiting_approval', `${execution.id}:${verified}`, () => api.getIntent(execution.id));
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
      {status === 'awaiting_review' ? <div id="review" tabIndex={-1}><ReviewPanel onReview={(verdict, feedback) => api.submitReview(execution.id, { verdict, ...(feedback === undefined ? {} : { feedback }) })} savedCode={events.some((event) => event.type === 'reuse_started')} taskId={execution.taskId} executionId={execution.id} {...(onRetried ? { onRetried } : {})} /></div> : null}
    </div>
  );
}
