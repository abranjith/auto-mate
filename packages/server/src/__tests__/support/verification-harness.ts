// Shared test support: FEAT-106's generation harness with FEAT-107's gate
// wired in — verification, approval, the real run, and the review — over a
// temporary data root, a scripted agent, a scripted Python runner, a fake
// runtime probe, and fake checkers. Not a test file.
import pino from 'pino';
import type { ExecutionRow } from '../../db/repositories/execution-repository';
import { VerificationRepository } from '../../db/repositories/verification-repository';
import { ApprovalRepository } from '../../db/repositories/approval-repository';
import { ScriptRunRepository } from '../../db/repositories/script-run-repository';
import { ExecutionStateWriter } from '../../verification/execution-state-writer';
import { VerificationService } from '../../verification/verification-service';
import { RunIntentService } from '../../verification/run-intent-service';
import { ApprovalService } from '../../verification/approval-service';
import { ScriptRunService } from '../../execution/script-run-service';
import type { RuntimeProvisioner } from '../../execution/runtime-provisioner';
import { ReviewService } from '../../verification/review-service';
import { FakeCheckerEnvironment, FakeRuntimeProbe, type FakeCheckerResponse } from '../../verification/testing/fake-runtime-probe';
import type { CheckerTool } from '../../verification/verify-env';
import { createGenerationHarness, type HarnessOptions } from './generation-harness';
import { finalizedSteps } from './verification-fixtures';

export interface VerificationHarnessOptions extends HarnessOptions {
  readonly finalize?: Record<string, unknown>;
  readonly script?: string;
  readonly checkers?: (tool: CheckerTool, args: readonly string[]) => FakeCheckerResponse;
  readonly verificationTimeoutMs?: number;
  /** Replaces the real-run start after an approval; defaults to the harness's own run leg once wired. */
  readonly onApproved?: (executionId: number) => void;
  readonly scriptRunTimeoutMs?: number;
  readonly maxRunOutputBytes?: number;
  readonly provisioner?: Pick<RuntimeProvisioner, 'ensureRuntime' | 'getReadiness' | 'getLauncherDigest'>;
}

/** Build generation plus the FEAT-107 gate; runs are started by `run()` and hand off to verification. */
export async function createVerificationHarness(options: VerificationHarnessOptions = {}) {
  const ref: { verification?: VerificationService } = {};
  const h = await createGenerationHarness({
    pythonRuns: [{}, {}],
    ...options,
    steps: options.steps ?? ((upload) => finalizedSteps(upload?.storedFilename ?? 'none.csv', options.finalize, options.script)),
    onHandOff: (row: ExecutionRow) => { ref.verification!.start(row.id); },
  });
  const c = h.store.connection;
  const logger = pino({ level: 'silent' });
  const repos = { ...h.repos, verifications: new VerificationRepository(c), approvals: new ApprovalRepository(c), scriptRuns: new ScriptRunRepository(c) };
  const publish = (executionId: number, event: Parameters<typeof h.registry.publish>[1]) => h.registry.publish(executionId, event);
  const state = new ExecutionStateWriter(repos.executions, publish);
  const probe = new FakeRuntimeProbe();
  const checkers = new FakeCheckerEnvironment(options.checkers);
  const pass = { integrity: { project: (id: number) => h.workspace.project(id), fixtures: h.fixtureService }, checkers, runner: h.runner, limits: { lintTimeoutMs: 60_000, securityTimeoutMs: 120_000, testRunTimeoutMs: 120_000 } };
  const verification = new VerificationService({ executions: repos.executions, versions: repos.versions, verifications: repos.verifications, fixtures: repos.fixtures, uploads: repos.uploads, profiles: repos.profiles, probe, pass, paths: h.store.paths, state, publish, track: (id, job) => h.registry.track(id, job), logger, ...(options.verificationTimeoutMs ? { timeoutMs: options.verificationTimeoutMs } : {}) });
  ref.verification = verification;
  const intents = new RunIntentService({ executions: repos.executions, versions: repos.versions, verifications: repos.verifications, uploads: repos.uploads, profiles: repos.profiles });
  const approved: number[] = [];
  const scriptRun = new ScriptRunService({ executions: repos.executions, versions: repos.versions, uploads: repos.uploads, scriptRuns: repos.scriptRuns, runner: h.runner, probe, project: (id) => h.workspace.project(id), paths: h.store.paths, state, publish, track: (id, job) => h.registry.track(id, job), logger, ...(options.provisioner ? { provisioner: options.provisioner } : {}), ...(options.scriptRunTimeoutMs ? { timeoutMs: options.scriptRunTimeoutMs } : {}), ...(options.maxRunOutputBytes ? { maxOutputBytes: options.maxRunOutputBytes } : {}) });
  const hooks = { onApproved: (id: number) => { approved.push(id); if (options.onApproved) options.onApproved(id); else scriptRun.start(id); } };
  const approval = new ApprovalService({ executions: repos.executions, approvals: repos.approvals, intents, probe, state, publish, assertCapacity: () => h.registry.assertCapacity(), onApproved: (id) => hooks.onApproved(id), reverify: (id) => { verification.start(id); }, logger });
  const review = new ReviewService({ executions: repos.executions, state, publish, retry: (id, feedback) => h.service.retry(id, feedback, 'feedback'), logger });
  /** Run generation and wait until the hand-off's verification has settled too. */
  async function runToGate(execution: ExecutionRow = h.execution): Promise<ExecutionRow> {
    await h.run(execution);
    await settledPhases(execution.id);
    return repos.executions.getById(execution.id)!;
  }
  /** Wait for any tracked phase job (verification, run) of this execution. */
  async function settledPhases(executionId: number): Promise<void> {
    for (let spins = 0; spins < 400 && h.registry.isLive(executionId); spins += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  /** Wait until nothing is live for any execution of the task — retries included. */
  async function quiesce(): Promise<void> {
    for (const row of repos.executions.listByTask(h.task.id)) await settledPhases(row.id);
  }
  /** Approve with the server's own current intent digest. */
  function approve(executionId = h.execution.id, acknowledgedWarnings = true) {
    return approval.decide(executionId, { intentDigest: intents.buildRunIntent(executionId).intentDigest, decision: 'approved', acknowledgedWarnings });
  }
  return { ...h, repos, state, probe, checkers, verification, intents, approval, scriptRun, review, approved, hooks, pass, logger, publish, runToGate, settledPhases, quiesce, approve,
    /** Stop everything live before the data root is removed. */
    async dispose(): Promise<void> { await quiesce(); await h.dispose(); } };
}
export type VerificationHarness = Awaited<ReturnType<typeof createVerificationHarness>>;
