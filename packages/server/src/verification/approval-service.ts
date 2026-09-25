// ---------------------------------------------------------------------------
// The approval gate (FEAT-107 TASK-010).
//
// Execution starts on an explicit "Run it" and on nothing else. A decision is
// accepted only when:
//   1. the execution is waiting at the gate;
//   2. the digest the page sends equals the digest of the intent the server
//      rebuilds NOW — a stale tab fails loudly rather than approving
//      yesterday's plan;
//   3. the runtime, probed fresh, still has the fingerprint the code was
//      verified on — otherwise the run goes back to verification and the
//      person is told the concrete change instead of being asked to approve;
//   4. advisory findings, when present, were acknowledged.
// The approval row and the state change are one transaction (ApprovalRepository).
// ---------------------------------------------------------------------------

import {
  ApprovalIntentMismatchError,
  ExecutionNotApprovedError,
  ExecutionNotFoundError,
  ValidationError,
  describeRuntimeChange,
  type ApprovalRequest,
  type ApprovalResponse,
  type RuntimeDetail,
} from '@automate/core';
import type { Logger } from 'pino';
import type { ApprovalRepository } from '../db/repositories/approval-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { ExecutionStateWriter, Publish } from './execution-state-writer';
import type { RunIntentService } from './run-intent-service';
import type { RuntimeProbe } from './runtime-probe';

export interface ApprovalServiceDependencies {
  readonly executions: ExecutionRepository;
  readonly approvals: ApprovalRepository;
  readonly intents: RunIntentService;
  readonly probe: RuntimeProbe;
  readonly state: ExecutionStateWriter;
  readonly publish: Publish;
  /** Throws when starting a run would exceed the concurrency cap. */
  readonly assertCapacity: () => void;
  /** Starts the real run once the approval is recorded (TASK-011). */
  readonly onApproved: (executionId: number) => void;
  /** Starts a fresh verification when the runtime moved (TASK-009). */
  readonly reverify: (executionId: number) => void;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

/** Records a person's decision at the gate. */
export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDependencies) {}

  /**
   * Decide on a run.
   * @returns `approved` (the run starts), `cancelled` (the execution is aborted), or `reverify` with the concrete runtime changes.
   * @throws ExecutionNotApprovedError off the gate; ApprovalIntentMismatchError for a stale page; ValidationError for unacknowledged warnings.
   */
  async decide(executionId: number, request: ApprovalRequest): Promise<ApprovalResponse> {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    if (execution.status !== 'awaiting_approval') throw new ExecutionNotApprovedError(executionId, execution.status);
    const built = this.deps.intents.buildRunIntent(executionId);
    if (built.intentDigest !== request.intentDigest) throw new ApprovalIntentMismatchError();
    if (request.decision === 'cancelled') return this.record(executionId, built, request, 'aborted');
    const runtime = await this.deps.probe.probe(new AbortController().signal, { fresh: true });
    if (runtime.fingerprint !== built.run.runtimeFingerprint) return this.returnToVerification(executionId, JSON.parse(built.run.runtimeDetail) as RuntimeDetail, runtime.detail);
    if (built.run.advisoryCount > 0 && !request.acknowledgedWarnings) throw new ValidationError('Review the warnings and confirm you have read them before running.');
    this.deps.assertCapacity();
    const response = this.record(executionId, built, request, 'executing');
    this.deps.onApproved(executionId);
    return response;
  }

  private record(executionId: number, built: ReturnType<RunIntentService['buildRunIntent']>, request: ApprovalRequest, next: 'executing' | 'aborted'): ApprovalResponse {
    const decision = request.decision;
    const row = this.deps.approvals.decide({ executionId, codeVersionId: built.version.id, verificationRunId: built.run.id, contentDigest: built.run.contentDigest, runtimeFingerprint: built.run.runtimeFingerprint, intentDigest: built.intentDigest, decision, acknowledgedWarnings: built.run.advisoryCount > 0 && request.acknowledgedWarnings }, next);
    this.deps.publish(executionId, { type: 'approval_decided', approvalId: row.id, decision, acknowledgedWarnings: row.acknowledgedWarnings, at: new Date().toISOString() });
    this.deps.state.announce(executionId, 'awaiting_approval', next);
    this.deps.logger.info({ executionId, decision, acknowledgedWarnings: row.acknowledgedWarnings }, 'approval decided');
    return { outcome: decision, approvalId: row.id, runtimeChanges: [], status: next };
  }

  /** The runtime moved since verification: record nothing, check again, and say what changed. */
  private returnToVerification(executionId: number, before: RuntimeDetail, after: RuntimeDetail): ApprovalResponse {
    const changes = describeRuntimeChange(before, after);
    this.deps.state.move(executionId, 'verifying');
    this.deps.logger.warn({ executionId, changeCount: changes.length }, 'runtime changed since verification; re-verifying');
    this.deps.reverify(executionId);
    return { outcome: 'reverify', approvalId: null, runtimeChanges: changes, status: 'verifying' };
  }
}
