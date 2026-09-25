// FEAT-107 TASK-016: the path FEAT-106 stopped short of — generate, verify,
// approve, run, review, reject, retry — asserted on STORED ROWS and the
// transcript, never on service return values, so a service that reports
// success while writing nothing fails. Scenarios 1–5 also prove the gate makes
// no provider call: after generation, any `open()` fails the test.
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { ApprovalStaleError, type ConversationEvent } from '@automate/core';
import type { FakePythonRun } from '../execution/testing/fake-python-runner';
import { TaskSessionRegistry } from '../conversation/task-session-registry';
import { ScriptRunService } from '../execution/script-run-service';
import { ApprovalService } from '../verification/approval-service';
import { ExecutionStateWriter } from '../verification/execution-state-writer';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from './support/verification-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

const producing = (names: readonly string[]): FakePythonRun => ({ onRun: (request) => {
  const out = request.env.AUTOMATE_OUTPUT_DIR!;
  for (const name of names) writeFileSync(path.join(out, name), 'region,total\nNorth,1\n');
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ artifacts: names.map((filename) => ({ filename, type: 'csv', title: filename, description: '' })) }));
} });
const TWO_OUTPUTS = { declaredOutputs: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Per region.' }, { filename: 'counts.csv', type: 'csv', title: 'Counts', description: '' }] };

async function harness(options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness({ finalize: TWO_OUTPUTS, pythonRuns: [{}, {}, producing(['totals.csv', 'counts.csv'])], ...options });
  harnesses.push(h);
  return h;
}
/** From here on, opening a provider session is a test failure: the gate sends nothing to a model. */
function forbidProvider(h: VerificationHarness): string[] {
  const violations: string[] = [];
  h.provider.open = (options) => { violations.push(options.executionId); return Promise.reject(new Error('A provider session was opened after generation.')); };
  return violations;
}
const status = (h: VerificationHarness, id = h.execution.id) => h.repos.executions.getById(id)?.status;
const pythonRuns = (h: VerificationHarness) => (h.runner as unknown as { requests: unknown[] }).requests.length;
const count = (h: VerificationHarness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const states = (events: readonly ConversationEvent[]) => events.filter((event): event is Extract<ConversationEvent, { type: 'state_changed' }> => event.type === 'state_changed').map(({ from, to }) => `${from}>${to}`);
const gapFree = (events: readonly ConversationEvent[]) => expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));

describe('verify → approve → run → review, end to end', () => {
  it('1. the happy path: verified, parked, approved with the server\'s own digest, run on a copy, reviewed, completed', async () => {
    const h = await harness();
    await h.run();
    const violations = forbidProvider(h);
    await h.settledPhases(h.execution.id);
    expect(status(h)).toBe('awaiting_approval');
    expect(h.repos.verifications.getLatest(h.execution.id)).toMatchObject({ status: 'passed', blockingCount: 0 });
    await h.approve();
    await h.settledPhases(h.execution.id);
    expect(status(h)).toBe('awaiting_review');
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toMatchObject({ status: 'succeeded', declaredOutputCount: 2, producedOutputCount: 2 });
    expect(h.repos.approvals.getGranted(h.execution.id)?.contentDigest).toBe(h.repos.scriptRuns.getByExecution(h.execution.id)?.contentDigest);
    h.review.review(h.execution.id, { verdict: 'accepted' });
    expect(status(h)).toBe('completed');
    const transcript = h.transcript();
    gapFree(transcript);
    expect(states(transcript)).toEqual(['pending>generating', 'generating>verifying', 'verifying>awaiting_approval', 'awaiting_approval>executing', 'executing>awaiting_review', 'awaiting_review>completed']);
    expect(transcript.filter(({ type }) => ['verification_finished', 'approval_decided', 'run_finished', 'review_decided'].includes(type)).map(({ type }) => type)).toEqual(['verification_finished', 'approval_decided', 'run_finished', 'review_decided']);
    expect(violations).toEqual([]);
    expect(h.provider.opened).toHaveLength(1);
  });

  it('2. blocked: an undefined name never reaches the gate and never spawns a run', async () => {
    const h = await harness({ checkers: (tool) => (tool === 'ruff' ? { exitCode: 1, stdout: JSON.stringify([{ code: 'F821', filename: 'main.py', message: 'Undefined name `oops`', location: { row: 3, column: 5 } }]) } : {}) });
    await h.run();
    const violations = forbidProvider(h);
    await h.settledPhases(h.execution.id);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'VERIFICATION_BLOCKED' });
    expect(count(h, 'execution_approval')).toBe(0);
    expect(count(h, 'script_run')).toBe(0);
    expect(pythonRuns(h)).toBe(2);
    expect(states(h.transcript())).not.toContain('verifying>awaiting_approval');
    expect(violations).toEqual([]);
  });

  it('3. stale approval: code changed behind the service is refused with ApprovalStaleError and nothing spawns', async () => {
    const h = await harness({ onApproved: () => undefined });
    await h.runToGate();
    const violations = forbidProvider(h);
    await h.approve();
    h.store.connection.client.prepare("UPDATE code_file SET content = content || '\n# edited after approval' WHERE path = 'main.py'").run();
    const spawned = pythonRuns(h);
    await h.scriptRun.run(h.execution.id, new AbortController().signal);
    expect(pythonRuns(h)).toBe(spawned);
    expect(count(h, 'script_run')).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: new ApprovalStaleError('digest').code });
    expect(violations).toEqual([]);
  });

  it('4. runtime drift: approving after an upgrade returns to verifying with the concrete change instead of running', async () => {
    const h = await harness();
    await h.runToGate();
    const violations = forbidProvider(h);
    const digest = h.intents.buildRunIntent(h.execution.id).intentDigest;
    h.probe.upgrade({ pythonVersion: '3.13.1' });
    const response = await h.approval.decide(h.execution.id, { intentDigest: digest, decision: 'approved', acknowledgedWarnings: true });
    expect(response.runtimeChanges).toEqual(['Python changed from 3.12.4 to 3.13.1']);
    await h.settledPhases(h.execution.id);
    expect(count(h, 'execution_approval')).toBe(0);
    expect(count(h, 'script_run')).toBe(0);
    expect(count(h, 'verification_run')).toBe(2);
    expect(states(h.transcript())).toContain('awaiting_approval>verifying');
    expect(status(h)).toBe('awaiting_approval');
    expect(violations).toEqual([]);
  });

  it('5. restart at the gate: a rebuilt registry leaves it parked, and a later approval runs normally', async () => {
    const h = await harness();
    await h.runToGate();
    const violations = forbidProvider(h);
    await h.registry.drain(1_000);
    const logger = pino({ level: 'silent' });
    const registry = new TaskSessionRegistry({ provider: h.provider, executions: h.repos.executions, events: h.repos.events, strategy: h.strategy, paths: h.store.paths, model: () => ({ provider: 'fake', id: 'fake-model' }), auth: () => ({ mode: 'managed' }), logger, maxConcurrentExecutions: 1, onInterrupted: (id) => { h.repos.verifications.abortRunning(id); h.repos.scriptRuns.abortRunning(id); } });
    const before = h.repos.executions.getById(h.execution.id);
    expect(registry.reconcileOnStartup()).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)).toEqual(before);
    const publish = (id: number, event: Parameters<TaskSessionRegistry['publish']>[1]) => registry.publish(id, event);
    const state = new ExecutionStateWriter(h.repos.executions, publish);
    const runs = new ScriptRunService({ executions: h.repos.executions, versions: h.repos.versions, uploads: h.repos.uploads, scriptRuns: h.repos.scriptRuns, runner: h.runner, probe: h.probe, project: (id) => h.workspace.project(id), paths: h.store.paths, state, publish, track: (id, job) => registry.track(id, job), logger });
    const approval = new ApprovalService({ executions: h.repos.executions, approvals: h.repos.approvals, intents: h.intents, probe: h.probe, state, publish, assertCapacity: () => registry.assertCapacity(), onApproved: (id) => { runs.start(id); }, reverify: () => undefined, logger });
    await approval.decide(h.execution.id, { intentDigest: h.intents.buildRunIntent(h.execution.id).intentDigest, decision: 'approved', acknowledgedWarnings: true });
    for (let spin = 0; spin < 400 && registry.isLive(h.execution.id); spin += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(status(h)).toBe('awaiting_review');
    gapFree(h.transcript());
    expect(violations).toEqual([]);
  });

  it('6. rejection: a new feedback execution exists, the original is rejected and unchanged, and both are readable', async () => {
    const h = await harness();
    await h.runToGate();
    await h.approve();
    await h.settledPhases(h.execution.id);
    const before = { run: h.repos.scriptRuns.getByExecution(h.execution.id), approval: h.repos.approvals.getGranted(h.execution.id), verification: h.repos.verifications.getLatest(h.execution.id), transcript: h.transcript() };
    const response = h.review.review(h.execution.id, { verdict: 'rejected', feedback: 'Counts should exclude blank regions.' });
    const retry = h.repos.executions.getById(response.retryExecutionId!)!;
    expect(retry).toMatchObject({ trigger: 'feedback', retryOfExecutionId: h.execution.id, guidance: 'Counts should exclude blank regions.' });
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'rejected', reviewFeedback: 'Counts should exclude blank regions.' });
    expect({ run: h.repos.scriptRuns.getByExecution(h.execution.id), approval: h.repos.approvals.getGranted(h.execution.id), verification: h.repos.verifications.getLatest(h.execution.id), transcript: h.transcript().slice(0, before.transcript.length) }).toEqual(before);
    await h.quiesce();
    expect(h.transcript(retry.id).length).toBeGreaterThan(0);
    gapFree(h.transcript());
    gapFree(h.transcript(retry.id));
  });
});

describe('the gate opens no provider session and builds no prompt', () => {
  const serverSrc = path.resolve(import.meta.dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const full = path.join(dir, name); return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []; });
  const code = (file: string) => readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');
  it.each(['verification', 'execution'])('no module under src/%s imports the agent provider or the prompt assembler', (dir) => {
    for (const file of files(path.join(serverSrc, dir))) {
      const source = code(file);
      expect(source, file).not.toMatch(/from ['"][./]*(?:\.\.\/)?agent\//);
      expect(source, file).not.toMatch(/\b(?:AgentProvider|openProviderSession|runProviderSession|assemblePromptContext)\b/);
      expect(source, file).not.toMatch(/\brecordDiagnosticTransmission\s*\(/);
    }
  });
  it('fails when a deliberate provider import is added', () => {
    expect(`import { openProviderSession } from '../disclosure/disclosure-run-strategy';`).toMatch(/\b(?:AgentProvider|openProviderSession|runProviderSession|assemblePromptContext)\b/);
  });
});
