import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CHECK_KEYS, computeRuntimeFingerprint, type ConversationEvent } from '@automate/core';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from '../support/verification-harness';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'verification');
const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });
async function harness(options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness(options);
  harnesses.push(h);
  return h;
}
const events = (h: VerificationHarness, type: string) => h.transcript().filter((event) => event.type === type) as Extract<ConversationEvent, { type: string }>[];
const count = (h: VerificationHarness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Real bandit output with the recorded root pointed at wherever the version lives. */
const banditHigh = () => JSON.stringify({ errors: [], results: [{ test_id: 'B602', issue_severity: 'HIGH', issue_confidence: 'HIGH', filename: 'main.py', line_number: 7, col_offset: 4, issue_text: 'subprocess call with shell=True identified, security issue.' }] });

describe('VerificationService', () => {
  it('verifies a clean version with seven checks and parks the execution at the approval gate', async () => {
    const h = await harness();
    const row = await h.runToGate();
    expect(row.status).toBe('awaiting_approval');
    const run = h.repos.verifications.getWithChecks(h.repos.verifications.getLatest(h.execution.id)!.id)!;
    expect(run.status).toBe('passed');
    expect(run.checks.map(({ checkKey }) => checkKey)).toEqual([...CHECK_KEYS]);
    expect(run.checks.map(({ status }) => status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed']);
    const states = events(h, 'state_changed').map((event) => `${(event as { from: string }).from}>${(event as { to: string }).to}`);
    expect(states.slice(-2)).toEqual(['generating>verifying', 'verifying>awaiting_approval']);
    const seqs = h.transcript().map(({ seq }) => seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it('binds the pass to the version digest and the probed fingerprint as stored values', async () => {
    const h = await harness();
    await h.runToGate();
    const run = h.repos.verifications.getLatest(h.execution.id)!;
    const final = h.repos.versions.findFinal(h.execution.id)!;
    expect(run.contentDigest).toBe(final.contentDigest);
    expect(run.runtimeFingerprint).toBe(computeRuntimeFingerprint(h.probe.detail));
    expect(JSON.parse(run.runtimeDetail)).toEqual(h.probe.detail);
  });

  it('blocks on one HIGH/HIGH bandit finding: failed, a readable message, and no approval row', async () => {
    const h = await harness({ checkers: (tool) => (tool === 'bandit' ? { exitCode: 1, stdout: banditHigh() } : {}) });
    const row = await h.runToGate();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'VERIFICATION_BLOCKED', errorMessage: "This code can't run yet: 1 high-severity security finding." });
    expect(h.repos.verifications.getLatest(h.execution.id)).toMatchObject({ status: 'failed', blockingCount: 1 });
    expect(count(h, 'execution_approval')).toBe(0);
    const security = h.repos.verifications.getWithChecks(h.repos.verifications.getLatest(h.execution.id)!.id)!.checks.find(({ checkKey }) => checkKey === 'security');
    expect(security).toMatchObject({ status: 'failed', isBlocking: true });
  });

  it('keeps advisory findings visible without blocking', async () => {
    const ruff = readFileSync(path.join(FIXTURES, 'ruff-findings.json'), 'utf8').replace(/"code": "F821"/, '"code": "F841"');
    const h = await harness({ checkers: (tool) => (tool === 'ruff' ? { exitCode: 1, stdout: ruff } : {}) });
    expect((await h.runToGate()).status).toBe('awaiting_approval');
    const run = h.repos.verifications.getLatest(h.execution.id)!;
    expect(run).toMatchObject({ status: 'passed', blockingCount: 0, advisoryCount: 4 });
    expect(run.summary).toBe('No blocking problems found; 4 advisory findings to review.');
  });

  it('reuses the pass for an unchanged runtime and spawns nothing; a changed runtime creates a second pass', async () => {
    const h = await harness();
    await h.runToGate();
    const first = h.repos.verifications.getLatest(h.execution.id)!;
    const calls = h.checkers.calls.length;
    const runs = (h.runner as unknown as { requests: unknown[] }).requests.length;
    expect((await h.verification.verify(h.execution.id))?.id).toBe(first.id);
    expect(h.checkers.calls).toHaveLength(calls);
    expect((h.runner as unknown as { requests: unknown[] }).requests).toHaveLength(runs);
    h.probe.upgrade({ pythonVersion: '3.13.1' });
    const second = await h.verification.verify(h.execution.id, { fresh: true });
    expect(second?.id).not.toBe(first.id);
    expect(count(h, 'verification_run')).toBe(2);
  });

  it('rejects force on an unchanged runtime with a typed error, not a constraint message', async () => {
    const h = await harness();
    await h.runToGate();
    await expect(h.verification.verify(h.execution.id, { force: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/already been checked on this exact runtime/) });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_approval');
  });

  it('stops after a failed integrity check and writes the rest as skipped, never omitted', async () => {
    const h = await harness();
    await h.run();
    h.store.connection.client.prepare("UPDATE code_file SET content = content || '# tampered' WHERE path = 'main.py'").run();
    await h.settledPhases(h.execution.id);
    // The hand-off already verified; tamper and verify a fresh runtime to force a new pass.
    h.probe.upgrade({ uvVersion: 'uv 0.12.0' });
    await h.verification.verify(h.execution.id, { fresh: true });
    const run = h.repos.verifications.getWithChecks(h.repos.verifications.getLatest(h.execution.id)!.id)!;
    expect(new Set(run.checks.map(({ checkKey }) => checkKey))).toEqual(new Set(CHECK_KEYS));
    expect(run.checks.find(({ checkKey }) => checkKey === 'integrity')?.status).toBe('failed');
    expect(run.checks.filter(({ status }) => status === 'skipped').map(({ checkKey }) => checkKey)).toEqual(CHECK_KEYS.slice(1));
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('failed');
  });

  it('settles timed_out past the wall clock, keeping every completed check', async () => {
    const h = await harness({ verificationTimeoutMs: 50, checkers: (tool) => (tool === 'bandit' ? { waitUntil: new Promise(() => undefined) } : {}) });
    const row = await h.runToGate();
    const run = h.repos.verifications.getWithChecks(h.repos.verifications.getLatest(h.execution.id)!.id)!;
    expect(run.status).toBe('timed_out');
    expect(run.checks.find(({ checkKey }) => checkKey === 'lint')?.status).toBe('passed');
    expect(run.checks.find(({ checkKey }) => checkKey === 'tests')?.status).toBe('skipped');
    expect(row).toMatchObject({ status: 'failed', errorMessage: 'Checking took too long and was stopped, so this code cannot run yet.' });
  });

  it('settles aborted mid-pass and stops the in-flight checker', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const h = await harness({ checkers: (tool) => { if (tool === 'ruff') started(); return tool === 'ruff' ? { waitUntil: new Promise(() => undefined) } : {}; } });
    void h.run();
    await running;
    await h.registry.abort(h.execution.id);
    expect(h.repos.verifications.getLatest(h.execution.id)).toMatchObject({ status: 'aborted' });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('aborted');
    expect(h.checkers.calls.map(({ tool }) => tool)).toEqual(['ruff']);
  });

  it('announces counts and the summary, and never a finding message', async () => {
    const h = await harness({ checkers: (tool) => (tool === 'bandit' ? { exitCode: 1, stdout: banditHigh() } : {}) });
    await h.runToGate();
    const [finished] = events(h, 'verification_finished');
    expect(finished).toMatchObject({ status: 'failed', blockingCount: 1, advisoryCount: 0, runtimeDescription: 'Python 3.12.4 on Linux (x64)' });
    expect(JSON.stringify(finished)).not.toContain('shell=True');
  });

  it('fails a handed-off run plainly when the runtime cannot be probed', async () => {
    const h = await harness();
    h.probe.failWith = Object.assign(new Error('no uv'), { code: 'X' });
    const row = await h.runToGate();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'PYTHON_RUNTIME_UNAVAILABLE' });
    expect(count(h, 'verification_run')).toBe(0);
  });
});
