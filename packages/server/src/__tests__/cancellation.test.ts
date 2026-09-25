// FEAT-107 TASK-013: every leg added by this feature cancels through the ONE
// existing abort path — a verification pass, the approval gate, a real run,
// and the review gate — and shutdown drains the live ones.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionNotRunningError, type ConversationEvent } from '@automate/core';
import type { FakePythonRun } from '../execution/testing/fake-python-runner';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from './support/verification-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });
async function harness(options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness({ onApproved: () => undefined, ...options });
  harnesses.push(h);
  return h;
}
const hang = () => new Promise<void>(() => undefined);
const count = (h: VerificationHarness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const aborts = (h: VerificationHarness) => h.transcript().filter((event: ConversationEvent) => event.type === 'state_changed' && event.to === 'aborted');
const requests = (h: VerificationHarness) => (h.runner as unknown as { requests: unknown[] }).requests.length;
const producing: FakePythonRun = { onRun: (request) => { writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'totals.csv'), 'a\n'); writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'T', description: '' }] })); } };
async function until(predicate: () => boolean): Promise<void> {
  for (let spin = 0; spin < 400 && !predicate(); spin += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Start generation and wait until ruff is running inside the verification pass. */
async function verifying() {
  let entered = false;
  const h = await harness({ checkers: (tool) => { if (tool === 'ruff') entered = true; return tool === 'ruff' ? { waitUntil: hang() } : {}; } });
  void h.run();
  await until(() => entered);
  return h;
}
/** Approve and wait until the real run's process is running. */
async function executing() {
  const h = await harness({ pythonRuns: [{}, {}, { waitUntil: hang() }] });
  await h.runToGate();
  await h.approve();
  h.scriptRun.start(h.execution.id);
  await until(() => requests(h) === 3);
  return h;
}
async function atReview() {
  const h = await harness({ pythonRuns: [{}, {}, producing] });
  await h.runToGate();
  await h.approve();
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
  return h;
}

describe('cancellation across the FEAT-107 legs', () => {
  it('aborting verification stops the checker and settles the pass and the execution', async () => {
    const h = await verifying();
    const row = await h.registry.abort(h.execution.id);
    expect(row.status).toBe('aborted');
    const pass = h.repos.verifications.getLatest(h.execution.id)!;
    expect(pass.status).toBe('aborted');
    expect(pass.settledAt).toBeInstanceOf(Date);
    expect(h.checkers.calls.map(({ tool }) => tool)).toEqual(['ruff']);
    expect(requests(h)).toBe(1);
  });

  it('aborting a real run kills it and settles both rows', async () => {
    const h = await executing();
    const row = await h.registry.abort(h.execution.id);
    expect(row.status).toBe('aborted');
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toMatchObject({ status: 'aborted' });
  });

  it('aborting at the approval gate writes no approval and spawns nothing', async () => {
    const h = await harness();
    await h.runToGate();
    const spawned = requests(h);
    const row = await h.registry.abort(h.execution.id);
    expect(row.status).toBe('aborted');
    expect(count(h, 'execution_approval')).toBe(0);
    expect(count(h, 'script_run')).toBe(0);
    expect(requests(h)).toBe(spawned);
    expect(aborts(h)).toHaveLength(1);
  });

  it('aborting at the review gate settles aborted and creates no retry', async () => {
    const h = await atReview();
    const row = await h.registry.abort(h.execution.id);
    expect(row.status).toBe('aborted');
    expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(1);
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)?.status).toBe('succeeded');
  });

  it('refuses to abort a terminal execution', async () => {
    const h = await atReview();
    h.review.review(h.execution.id, { verdict: 'accepted' });
    await expect(h.registry.abort(h.execution.id)).rejects.toBeInstanceOf(ExecutionNotRunningError);
  });

  it.each([['verification', verifying], ['a real run', executing], ['the approval gate', async () => { const h = await harness(); await h.runToGate(); return h; }], ['the review gate', atReview]] as const)('is idempotent under concurrent calls during %s', async (_leg, setup) => {
    const h = await setup();
    const results = await Promise.allSettled([h.registry.abort(h.execution.id), h.registry.abort(h.execution.id)]);
    expect(results.some(({ status }) => status === 'fulfilled')).toBe(true);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(ExecutionNotRunningError);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('aborted');
    expect(aborts(h)).toHaveLength(1);
  });

  it('drain stops a live verification and a live run within the timeout', async () => {
    const first = await verifying();
    const second = await executing();
    await Promise.all([first.registry.drain(1_000), second.registry.drain(1_000)]);
    expect(first.repos.verifications.getLatest(first.execution.id)?.status).toBe('aborted');
    expect(second.repos.scriptRuns.getByExecution(second.execution.id)?.status).toBe('aborted');
    for (const h of [first, second]) expect(['aborted', 'failed']).toContain(h.repos.executions.getById(h.execution.id)?.status);
  });
});
