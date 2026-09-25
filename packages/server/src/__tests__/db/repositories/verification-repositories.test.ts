import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalStaleError, CHECK_KEYS, ExecutionNotApprovedError, type RuntimeDetail } from '@automate/core';
import type { DatabaseConnection } from '../../../db/client';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { ExecutionRepository } from '../../../db/repositories/execution-repository';
import { CodeVersionRepository } from '../../../db/repositories/code-version-repository';
import { VerificationRepository, type NewCheck } from '../../../db/repositories/verification-repository';
import { ApprovalRepository, type NewApproval } from '../../../db/repositories/approval-repository';
import { ScriptRunRepository, type OpenGatedRun } from '../../../db/repositories/script-run-repository';
import { createTempStore, type TempStore } from '../../support/ingestion-fixtures';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

const RUNTIME: RuntimeDetail = { pythonVersion: '3.12.4', uvVersion: 'uv 0.8.0', platform: 'linux', arch: 'x64', packages: [] };
const FP = 'f'.repeat(64);

function setup() {
  const store = createTempStore('automate-verify-repo-');
  stores.push(store);
  const c = store.connection;
  const created = new TaskRepository(c).createWithExecution('Summarize sales');
  const executions = new ExecutionRepository(c);
  const versions = new CodeVersionRepository(c);
  const draft = versions.openDraft(created.execution.id, 1);
  versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'print(1)\n' });
  const sealed = versions.seal(draft.id);
  return { c, executions, versions, sealed, execution: created.execution, verifications: new VerificationRepository(c), approvals: new ApprovalRepository(c), runs: new ScriptRunRepository(c) };
}
const count = (c: DatabaseConnection, table: string) => (c.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const finding = (isBlocking: boolean, ruleCode = isBlocking ? 'F821' : 'F401') => ({ ruleCode, severity: 'high' as const, confidence: null, filePath: 'main.py', line: 1, column: 1, message: 'm', isBlocking });
const checks = (): NewCheck[] => CHECK_KEYS.map((checkKey) => ({ checkKey, status: 'passed', isBlocking: true, summary: 'ok', detail: { n: 1 }, durationMs: 3, findings: checkKey === 'lint' ? [finding(true), finding(false), finding(false)] : [] }));

function toApproval(s: ReturnType<typeof setup>, runId: number, overrides: Partial<NewApproval> = {}): NewApproval {
  return { executionId: s.execution.id, codeVersionId: s.sealed.id, verificationRunId: runId, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, intentDigest: 'i'.repeat(64), decision: 'approved', acknowledgedWarnings: false, ...overrides };
}
function gated(s: ReturnType<typeof setup>, overrides: Partial<OpenGatedRun> = {}): OpenGatedRun {
  return { executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, dirPath: `runs/${s.execution.id}`, inputs: [], ...overrides };
}
/** Move the execution to the approval gate and record a passed verification. */
function atGate(s: ReturnType<typeof setup>) {
  s.executions.markStarted(s.execution.id);
  s.executions.transitionStatus(s.execution.id, 'verifying');
  s.executions.transitionStatus(s.execution.id, 'awaiting_approval');
  const run = s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
  s.verifications.settle(run.id, { status: 'passed', summary: 's', durationMs: 5, checks: checks() });
  return run;
}

describe('VerificationRepository', () => {
  it('round-trips a pass with seven checks and counts equal to the partitioned findings', () => {
    const s = setup();
    const run = s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
    expect(run).toMatchObject({ status: 'running', settledAt: null, blockingCount: 0 });
    const settled = s.verifications.settle(run.id, { status: 'failed', summary: 'blocked', durationMs: 12, checks: checks() });
    expect(settled.checks.map(({ checkKey }) => checkKey)).toEqual([...CHECK_KEYS]);
    expect(settled).toMatchObject({ status: 'failed', blockingCount: 1, advisoryCount: 2, durationMs: 12 });
    expect(settled.settledAt).toBeInstanceOf(Date);
    expect(settled.findings.map(({ checkKey }) => checkKey)).toEqual(['lint', 'lint', 'lint']);
    expect(JSON.parse(settled.runtimeDetail)).toEqual(RUNTIME);
  });
  it('writes every missing key as skipped', () => {
    const s = setup();
    const run = s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
    const settled = s.verifications.settle(run.id, { status: 'failed', summary: 'x', durationMs: 1, checks: [checks()[0]!] });
    expect(new Set(settled.checks.map(({ checkKey }) => checkKey))).toEqual(new Set(CHECK_KEYS));
    expect(settled.checks.filter(({ status }) => status === 'skipped')).toHaveLength(6);
  });
  it('finds by scope and never overwrites a pass for the same pair', () => {
    const s = setup();
    const run = s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
    expect(s.verifications.findByScope(s.sealed.id, FP)?.id).toBe(run.id);
    expect(s.verifications.findByScope(s.sealed.id, 'e'.repeat(64))).toBeUndefined();
    expect(() => s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME })).toThrow(/already been checked/);
    expect(count(s.c, 'verification_run')).toBe(1);
    const second = s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: 'e'.repeat(64), runtimeDetail: RUNTIME });
    expect(s.verifications.getLatest(s.execution.id)?.id).toBe(second.id);
  });
  it('rejects a settled status with no settled_at at the CHECK', () => {
    const s = setup();
    const run = s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
    expect(() => s.c.client.prepare("UPDATE verification_run SET status = 'passed' WHERE id = ?").run(run.id)).toThrow(/CHECK/);
  });
  it('settles running passes aborted with every key present', () => {
    const s = setup();
    s.verifications.open({ executionId: s.execution.id, codeVersionId: s.sealed.id, contentDigest: s.sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
    expect(s.verifications.abortRunning(s.execution.id)).toBe(1);
    const latest = s.verifications.getWithChecks(s.verifications.getLatest(s.execution.id)!.id)!;
    expect(latest.status).toBe('aborted');
    expect(latest.checks).toHaveLength(7);
    expect(s.verifications.abortRunning(s.execution.id)).toBe(0);
  });
  it('cascades execution → run → check → finding, and removes the approval and the run row', () => {
    const s = setup();
    const run = atGate(s);
    s.approvals.decide(toApproval(s, run.id), 'executing');
    s.runs.openGated(gated(s));
    expect([count(s.c, 'verification_run'), count(s.c, 'verification_check'), count(s.c, 'verification_finding'), count(s.c, 'execution_approval'), count(s.c, 'script_run')]).toEqual([1, 7, 3, 1, 1]);
    s.c.client.prepare('DELETE FROM execution WHERE id = ?').run(s.execution.id);
    expect([count(s.c, 'verification_run'), count(s.c, 'verification_check'), count(s.c, 'verification_finding'), count(s.c, 'execution_approval'), count(s.c, 'script_run')]).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('ApprovalRepository', () => {
  it('records an approval and moves the execution in one step', () => {
    const s = setup();
    const run = atGate(s);
    const row = s.approvals.decide(toApproval(s, run.id, { acknowledgedWarnings: true }), 'executing');
    expect(row).toMatchObject({ decision: 'approved', acknowledgedWarnings: true });
    expect(s.executions.getById(s.execution.id)?.status).toBe('executing');
    expect(s.approvals.getGranted(s.execution.id)?.id).toBe(row.id);
  });
  it('accepts a cancelled row beside an approved one but never a second approval', () => {
    const s = setup();
    const run = atGate(s);
    s.c.client.prepare("INSERT INTO execution_approval (execution_id, code_version_id, verification_run_id, content_digest, runtime_fingerprint, intent_digest, decision) VALUES (?, ?, ?, 'a', 'b', 'c', 'cancelled')").run(s.execution.id, s.sealed.id, run.id);
    s.approvals.decide(toApproval(s, run.id), 'executing');
    expect(() => s.c.client.prepare("INSERT INTO execution_approval (execution_id, code_version_id, verification_run_id, content_digest, runtime_fingerprint, intent_digest, decision) VALUES (?, ?, ?, 'a', 'b', 'c', 'approved')").run(s.execution.id, s.sealed.id, run.id)).toThrow(/UNIQUE/);
    expect(s.approvals.listByExecution(s.execution.id).map(({ decision }) => decision)).toEqual(['cancelled', 'approved']);
  });
  it('refuses a decision outside the gate and writes nothing', () => {
    const s = setup();
    const run = atGate(s);
    s.approvals.decide(toApproval(s, run.id), 'executing');
    expect(() => s.approvals.decide(toApproval(s, run.id), 'executing')).toThrow(ExecutionNotApprovedError);
    expect(count(s.c, 'execution_approval')).toBe(1);
  });
  it('settles a cancellation as aborted', () => {
    const s = setup();
    const run = atGate(s);
    s.approvals.decide(toApproval(s, run.id, { decision: 'cancelled' }), 'aborted');
    expect(s.executions.getById(s.execution.id)).toMatchObject({ status: 'aborted' });
    expect(s.executions.getById(s.execution.id)?.completedAt).toBeInstanceOf(Date);
    expect(s.approvals.getGranted(s.execution.id)).toBeUndefined();
  });
});

describe('ScriptRunRepository.openGated', () => {
  it('inserts when the approval matches', () => {
    const s = setup();
    s.approvals.decide(toApproval(s, atGate(s).id), 'executing');
    const row = s.runs.openGated(gated(s, { inputs: [{ uploadId: 1, storedFilename: 'a.csv', sha256: 'a'.repeat(64), byteSize: 3 }] }));
    expect(row).toMatchObject({ status: 'running', contentDigest: s.sealed.contentDigest, runtimeFingerprint: FP, dirPath: `runs/${s.execution.id}` });
    expect(JSON.parse(row.inputManifest)).toHaveLength(1);
  });
  it('throws ExecutionNotApprovedError with no approval, or only a cancelled one, and writes nothing', () => {
    const s = setup();
    const run = atGate(s);
    expect(() => s.runs.openGated(gated(s))).toThrow(ExecutionNotApprovedError);
    s.approvals.decide(toApproval(s, run.id, { decision: 'cancelled' }), 'aborted');
    expect(() => s.runs.openGated(gated(s))).toThrow(ExecutionNotApprovedError);
    expect(count(s.c, 'script_run')).toBe(0);
  });
  it.each([['digest', { contentDigest: '0'.repeat(64) }], ['runtime', { runtimeFingerprint: '1'.repeat(64) }]] as const)('throws ApprovalStaleError(%s) and writes nothing', (reason, change) => {
    const s = setup();
    s.approvals.decide(toApproval(s, atGate(s).id), 'executing');
    try { s.runs.openGated(gated(s, change)); expect.unreachable(); }
    catch (error) { expect(error).toBeInstanceOf(ApprovalStaleError); expect((error as ApprovalStaleError).reason).toBe(reason); }
    expect(count(s.c, 'script_run')).toBe(0);
  });
  it('allows one run per execution and settles it once', () => {
    const s = setup();
    s.approvals.decide(toApproval(s, atGate(s).id), 'executing');
    const row = s.runs.openGated(gated(s));
    expect(() => s.runs.openGated(gated(s))).toThrow(/already been started/);
    const settled = s.runs.settle(row.id, { status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '', outputTruncated: false, manifestPresent: true, manifestJson: '{}', declaredOutputCount: 1, producedOutputCount: 1, durationMs: 9 });
    expect(settled).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(s.runs.abortRunning(s.execution.id)).toBe(false);
    expect(() => s.c.client.prepare("UPDATE script_run SET settled_at = NULL WHERE id = ?").run(row.id)).toThrow(/CHECK/);
  });
});

describe('ExecutionRepository (FEAT-107)', () => {
  it('creates a feedback retry that leaves the original untouched', () => {
    const s = setup();
    const before = s.executions.getById(s.execution.id);
    const retry = s.executions.createFeedbackRetry(s.execution.id, 'The totals double-count refunds.');
    expect(retry).toMatchObject({ trigger: 'feedback', retryOfExecutionId: s.execution.id, guidance: 'The totals double-count refunds.', status: 'pending' });
    expect(s.executions.getById(s.execution.id)).toEqual(before);
  });
  it('marks a review and lists parked executions without waiting', () => {
    const s = setup();
    atGate(s);
    const second = s.executions.create(s.execution.taskId);
    s.executions.markStarted(second.id);
    s.executions.transitionStatus(second.id, 'waiting');
    expect(s.executions.listParked().map(({ id }) => id)).toEqual([s.execution.id]);
    expect(s.executions.listActive().map(({ id }) => id)).toEqual([second.id]);
    s.executions.transitionStatus(s.execution.id, 'executing');
    s.executions.transitionStatus(s.execution.id, 'awaiting_review');
    const reviewed = s.executions.markReviewed(s.execution.id, 'rejected', 'wrong');
    expect(reviewed).toMatchObject({ status: 'rejected', reviewFeedback: 'wrong' });
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
    expect(() => s.executions.markReviewed(s.execution.id, 'accepted', null)).toThrow(/cannot transition/);
  });
});
