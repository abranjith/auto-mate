import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ApprovalIntentMismatchError, ExecutionNotApprovedError, RUN_INTENT_CAVEATS, buildIntentDigest, type RunIntent } from '@automate/core';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from '../support/verification-harness';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'verification');
const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });
async function atGate(options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness({ onApproved: () => undefined, ...options });
  harnesses.push(h);
  expect((await h.runToGate()).status).toBe('awaiting_approval');
  return h;
}
const count = (h: VerificationHarness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const advisoryRuff = () => readFileSync(path.join(FIXTURES, 'ruff-findings.json'), 'utf8').replace(/"code": "F821"/, '"code": "F841"');

describe('buildRunIntent', () => {
  it('carries every caveat verbatim and no absolute path', async () => {
    const h = await atGate();
    const { intent } = h.intents.buildRunIntent(h.execution.id);
    expect(intent.caveats).toEqual([...RUN_INTENT_CAVEATS]);
    for (const caveat of RUN_INTENT_CAVEATS) expect(intent.caveats).toContain(caveat);
    const text = JSON.stringify(intent);
    for (const needle of [h.store.root, h.store.root.replace(/\\/g, '/'), h.store.root.replace(/\\/g, '\\\\')]) expect(text).not.toContain(needle);
    expect(intent).toMatchObject({ inputs: [expect.objectContaining({ originalFilename: 'sales.csv' })], outputs: [expect.objectContaining({ filename: 'totals.csv', type: 'csv' })], tests: { total: 3, passed: 3, fixtureRowCount: 200 }, blockingCount: 0 });
    expect(intent.runtime.description).toBe('Python 3.12.4 on Linux (x64)');
  });

  it('is stable across calls and moves with any field the gate shows', async () => {
    const h = await atGate();
    const { intent, intentDigest } = h.intents.buildRunIntent(h.execution.id);
    expect(h.intents.buildRunIntent(h.execution.id).intentDigest).toBe(intentDigest);
    const mutations: ((copy: RunIntent) => RunIntent)[] = [
      (copy) => ({ ...copy, checks: copy.checks.map((check, index) => (index === 4 ? { ...check, status: 'failed' } : check)) }),
      (copy) => ({ ...copy, outputs: [{ ...copy.outputs[0]!, filename: 'other.csv' }] }),
      (copy) => ({ ...copy, outputs: [{ ...copy.outputs[0]!, title: 'Different' }] }),
      (copy) => ({ ...copy, runtime: { ...copy.runtime, fingerprint: 'e'.repeat(64) } }),
      (copy) => ({ ...copy, runtime: { ...copy.runtime, packages: [] } }),
      (copy) => ({ ...copy, inputs: [{ ...copy.inputs[0]!, byteSize: 1 }] }),
      (copy) => ({ ...copy, advisoryCount: 1 }),
      (copy) => ({ ...copy, caveats: copy.caveats.slice(1) }),
      (copy) => ({ ...copy, summary: 'softer' }),
      (copy) => ({ ...copy, codeVersion: { ...copy.codeVersion, contentDigest: '0'.repeat(64) } }),
    ];
    for (const mutate of mutations) expect(buildIntentDigest(mutate(structuredClone(intent)))).not.toBe(intentDigest);
  });
});

describe('ApprovalService.decide', () => {
  it('records the approval, moves to executing, and starts the run', async () => {
    const h = await atGate();
    const response = await h.approve();
    expect(response).toMatchObject({ outcome: 'approved', status: 'executing', runtimeChanges: [] });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('executing');
    expect(h.repos.approvals.getGranted(h.execution.id)).toMatchObject({ contentDigest: h.repos.versions.findFinal(h.execution.id)!.contentDigest, decision: 'approved' });
    expect(h.approved).toEqual([h.execution.id]);
    expect(h.transcript().slice(-2).map(({ type }) => type)).toEqual(['approval_decided', 'state_changed']);
  });

  it('rejects a stale digest, writes nothing, and moves nothing', async () => {
    const h = await atGate();
    await expect(h.approval.decide(h.execution.id, { intentDigest: 'f'.repeat(64), decision: 'approved', acknowledgedWarnings: true })).rejects.toBeInstanceOf(ApprovalIntentMismatchError);
    expect(count(h, 'execution_approval')).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_approval');
    expect(h.approved).toEqual([]);
  });

  it('requires acknowledgement when advisory findings exist', async () => {
    const h = await atGate({ checkers: (tool) => (tool === 'ruff' ? { exitCode: 1, stdout: advisoryRuff() } : {}) });
    await expect(h.approve(h.execution.id, false)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(count(h, 'execution_approval')).toBe(0);
    await h.approve(h.execution.id, true);
    expect(h.repos.approvals.getGranted(h.execution.id)?.acknowledgedWarnings).toBe(true);
  });

  it('returns to verifying with the concrete changes when the runtime moved, writing no approval', async () => {
    const h = await atGate();
    const digest = h.intents.buildRunIntent(h.execution.id).intentDigest;
    h.probe.upgrade({ pythonVersion: '3.13.1', packages: [{ name: 'pandas', version: '2.4.0' }, { name: 'pytest', version: '8.4.2' }] });
    const response = await h.approval.decide(h.execution.id, { intentDigest: digest, decision: 'approved', acknowledgedWarnings: true });
    expect(response).toEqual({ outcome: 'reverify', approvalId: null, runtimeChanges: ['Python changed from 3.12.4 to 3.13.1', 'pandas changed from 2.3.1 to 2.4.0'], status: 'verifying' });
    expect(count(h, 'execution_approval')).toBe(0);
    await h.settledPhases(h.execution.id);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_approval');
    expect(count(h, 'verification_run')).toBe(2);
    expect(h.approved).toEqual([]);
  });

  it('records a cancellation and aborts the execution', async () => {
    const h = await atGate();
    const response = await h.approval.decide(h.execution.id, { intentDigest: h.intents.buildRunIntent(h.execution.id).intentDigest, decision: 'cancelled', acknowledgedWarnings: false });
    expect(response).toMatchObject({ outcome: 'cancelled', status: 'aborted' });
    expect(h.repos.approvals.listByExecution(h.execution.id).map(({ decision }) => decision)).toEqual(['cancelled']);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('aborted');
  });

  it('refuses a decision off the gate, including a second approval', async () => {
    const h = await atGate();
    await h.approve();
    await expect(h.approve()).rejects.toBeInstanceOf(ExecutionNotApprovedError);
    expect(count(h, 'execution_approval')).toBe(1);
  });

  it('refuses at the concurrency cap and records nothing', async () => {
    const h = await atGate();
    const originalAssert = h.registry.assertCapacity.bind(h.registry);
    h.registry.assertCapacity = () => { throw Object.assign(new Error('limit'), { code: 'EXECUTION_LIMIT_REACHED' }); };
    await expect(h.approve()).rejects.toThrow('limit');
    h.registry.assertCapacity = originalAssert;
    expect(count(h, 'execution_approval')).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_approval');
  });
});
