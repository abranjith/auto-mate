import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { INTERRUPTION_MESSAGES } from '@automate/core';
import { FakeAgentProvider } from '../../agent/testing/fake-agent-provider';
import { PassthroughRunStrategy } from '../../conversation/run-strategy';
import { TaskSessionRegistry } from '../../conversation/task-session-registry';
import { ConversationEventRepository } from '../../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { createGenerationHarness, COMPLETED, type GenerationHarness } from '../support/generation-harness';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';

const harnesses: GenerationHarness[] = [];
const stores: TempStore[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  stores.splice(0).forEach((store) => store.dispose());
});

/** A day-first date column forces at least one required pre-flight decision. */
const DATES = ['order_id,when,amount', ...Array.from({ length: 30 }, (_, index) => `${index + 1},0${(index % 9) + 1}/0${(index % 3) + 1}/2026,${index}.5`)].join('\n');

async function harness() {
  const h = await createGenerationHarness({ files: [{ name: 'orders.csv', bytes: Buffer.from(`${DATES}\n`), format: 'csv' }], steps: () => [] });
  harnesses.push(h);
  return h;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let spins = 0; spins < 200 && !predicate(); spins++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('restart partition for a waiting run (FEAT-105/FEAT-107 conflict)', () => {
  it('interrupts waiting with its clarification, continues the transcript gap-free, and the retry seeds the earlier answers', async () => {
    const h = await harness();
    const uploadIds = h.uploads.map(({ id }) => id);
    const required = h.disclosure.buildPreview(uploadIds).required;
    expect(required.length).toBeGreaterThan(0);
    h.preflight.persist(h.execution.id, h.preflight.resolveDecisions(uploadIds, required.map((finding) => ({ findingKey: finding.findingKey, choice: finding.options[0]!.value }))));
    const pending = h.repos.clarifications.open({ executionId: h.execution.id, source: 'agent', callId: 'call-1', questions: [{ impact: 'meaning', promptText: 'Which month?', rationale: 'Ambiguous', proposedDefault: 'latest' }] });
    h.store.connection.client.prepare("update execution set status = 'waiting', started_at = 1 where id = ?").run(h.execution.id);
    h.registry.publish(h.execution.id, { type: 'user_prompt', text: 'Total it', at: new Date().toISOString() });
    h.registry.publish(h.execution.id, { type: 'state_changed', from: 'generating', to: 'waiting', at: new Date().toISOString() });

    expect(h.registry.reconcileOnStartup()).toBe(1);
    expect(h.registry.reconcileOnStartup()).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)).toMatchObject({ status: 'failed', errorCode: 'EXECUTION_INTERRUPTED', errorMessage: INTERRUPTION_MESSAGES.waiting });
    expect(h.repos.clarifications.listByExecution(h.execution.id).find(({ id }) => id === pending.id)?.status).toBe('interrupted');
    const transcript = h.transcript();
    expect(transcript.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(transcript.at(-1)).toMatchObject({ type: 'state_changed', from: 'waiting', to: 'failed' });

    h.provider.enqueue([{ events: [], steps: [], result: COMPLETED }]);
    const created = h.service.retry(h.execution.id, null);
    await h.registry.get(created.execution.id)?.settled;
    const seeded = h.repos.clarifications.listByExecution(created.execution.id).flatMap(({ questions }) => questions);
    expect(seeded).toHaveLength(required.length);
    expect(seeded.every(({ answerSource }) => answerSource === 'seeded')).toBe(true);
  });
});

describe('one open run per task', () => {
  it('lets two concurrent retry requests create exactly one execution', async () => {
    const h = await harness();
    h.repos.executions.markSettled(h.execution.id, { status: 'failed' });
    const uploadIds = h.uploads.map(({ id }) => id);
    const decisions = h.disclosure.buildPreview(uploadIds).required.map((finding) => ({ findingKey: finding.findingKey, choice: finding.options[0]!.value }));
    h.provider.enqueue([{ events: [], steps: [], result: COMPLETED, waitUntil: new Promise<void>(() => undefined) }]);
    const { base } = await h.serve();
    const post = () => fetch(`${base}/api/executions/${h.execution.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guidance: 'again', preflightDecisions: decisions }) });
    const responses = await Promise.all([post(), post()]);
    const bodies = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json() as { error?: { code: string } } })));
    expect(bodies.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(bodies.find(({ status }) => status === 409)?.body.error?.code).toBe('TASK_HAS_OPEN_RUN');
    expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(2);
    for (const row of h.repos.executions.listByTask(h.task.id)) if (h.registry.isLive(row.id)) await h.registry.abort(row.id);
  });
});

describe('abort reasons', () => {
  it('records a graceful shutdown differently from a person cancelling — the pair proves the distinction', async () => {
    const store = createTempStore('automate-abort-reason-'); stores.push(store);
    const tasks = new TaskRepository(store.connection); const executions = new ExecutionRepository(store.connection);
    const provider = new FakeAgentProvider();
    const registry = new TaskSessionRegistry({ provider, executions, events: new ConversationEventRepository(store.connection), strategy: new PassthroughRunStrategy(), paths: store.paths, model: () => ({ provider: 'fake', id: 'fake' }), auth: () => ({ mode: 'managed' }), logger: pino({ level: 'silent' }), maxConcurrentExecutions: 4 });
    const never = new Promise<void>(() => undefined);
    for (let session = 0; session < 2; session++) provider.enqueue([{ events: [], result: COMPLETED, waitUntil: never }]);
    const cancelled = tasks.createWithExecution('I cancel this'); const closed = tasks.createWithExecution('The app closes on this');
    registry.start(cancelled.execution, cancelled.task); registry.start(closed.execution, closed.task);
    await until(() => provider.sessions.length === 2);
    await registry.abort(cancelled.execution.id);
    await registry.get(cancelled.execution.id)?.settled.catch(() => undefined);
    await registry.drain(1_000);
    expect(executions.getById(cancelled.execution.id)).toMatchObject({ status: 'aborted', errorCode: null });
    expect(executions.getById(closed.execution.id)).toMatchObject({ status: 'aborted', errorCode: 'EXECUTION_STOPPED_ON_SHUTDOWN' });
  });
});
