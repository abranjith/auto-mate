import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { describeLimitBreach, type RunRecord } from '@automate/core';
import { createTempStore, type TempStore } from './support/ingestion-fixtures';
import { capturingLogger, startFullApp, type FullApp } from './support/history-app';
import { createApp } from '../app';
import { getServerConfig } from '../config/env';
import { HistoryRepository } from '../db/repositories/history-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskDeletionService } from '../history/task-deletion-service';
import type { TaskSessionRegistry } from '../conversation/task-session-registry';
import type { FakePythonRun } from '../execution/testing/fake-python-runner';

const stores: TempStore[] = []; const servers: Server[] = []; const apps: FullApp[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  stores.splice(0).forEach((store) => store.dispose());
  for (const app of apps.splice(0)) await app.close();
});

async function fixture() {
  const store = createTempStore('automate-history-route-'); stores.push(store);
  const tasks = new TaskRepository(store.connection); const executions = new ExecutionRepository(store.connection); const history = new HistoryRepository(store.connection);
  const { logger, lines } = capturingLogger(); const config = getServerConfig({});
  const registry = { isLive: () => false } as unknown as TaskSessionRegistry;
  const deletion = new TaskDeletionService({ paths: store.paths, tasks, executions, registry, logger });
  const app = createApp({ logger, dataRoot: store.root, version: '0.1.0', getSchemaVersion: () => '1', paths: store.paths, serverConfig: config, conversation: { tasks, executions, events: new ConversationEventRepository(store.connection), registry }, history: { history, tasks, deletion, config } });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  config.port = address.port;
  return { store, tasks, executions, history, deletion, lines, base: `http://127.0.0.1:${address.port}` };
}

/** The data root as it could appear in a JSON body: raw, and with JSON-escaped separators. */
const rootForms = (root: string) => [root, JSON.stringify(root).slice(1, -1), root.split(path.sep).join('/')];

/** A python run that writes one declared output, so the run registers an artifact. */
const writesOutput: FakePythonRun = {
  onRun: (request) => {
    if (!request.env.AUTOMATE_OUTPUT_DIR || !request.args.includes('main.py')) return;
    writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR, 'totals.csv'), 'region,total\nnorth,1\n');
    writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Report' }] }));
  },
  result: { stdout: 'done', exitCode: 0, outcome: 'passed' },
};

/** Drive one task through every feature: disclosure, generation, a question, verification, approval, a run, outputs, and acceptance. */
async function fullyPopulated(options: Parameters<typeof startFullApp>[0] = {}) {
  const full = await startFullApp({ pythonRuns: [{}, {}, writesOutput], ...options }); apps.push(full);
  const { h } = full;
  expect((await h.runToGate()).status).toBe('awaiting_approval');
  await h.approve(); await h.scriptRun.run(h.execution.id, new AbortController().signal);
  h.review.review(h.execution.id, { verdict: 'accepted' });
  h.repos.clarifications.open({ executionId: h.execution.id, source: 'preflight', status: 'answered', questions: [{ findingKey: 'dates', impact: 'meaning', promptText: 'QUESTION-SENTINEL', rationale: 'RATIONALE-SENTINEL', proposedDefault: 'a', answer: 'ANSWER-SENTINEL', answerSource: 'user' }] });
  return full;
}

describe('GET /api/tasks', () => {
  it('lists, pages, filters, and serves a sparse record with safe headers', async () => {
    const s = await fixture();
    for (let i = 1; i <= 3; i++) s.tasks.createWithExecution(`Task ${i}`);
    const response = await fetch(`${s.base}/api/tasks?limit=2`);
    const page = await response.json() as { items: { task: { id: number } }[]; nextCursor: string; hasMore: boolean };
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const second = await fetch(`${s.base}/api/tasks?limit=2&cursor=${page.nextCursor}`);
    expect((await second.json() as { items: { task: { id: number } }[] }).items.map((item) => item.task.id)).toEqual([1]);
    const record = await fetch(`${s.base}/api/executions/1/record`);
    expect(await record.json()).toMatchObject({ execution: { id: 1 }, inputs: [], disclosure: null, transcript: { lastSeq: 0 } });
  });

  it('rejects out-of-range limits, non-numeric cursors, unknown parameters, and unknown filters with the envelope', async () => {
    const s = await fixture();
    const tooMany = await fetch(`${s.base}/api/tasks?limit=51`);
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('50'), correlationId: expect.any(String) } });
    for (const query of ['cursor=abc', 'cursor=0', 'limit=0', 'other=yes', 'status=unknown', `q=${'x'.repeat(201)}`]) {
      expect((await fetch(`${s.base}/api/tasks?${query}`)).status, query).toBe(400);
    }
  });

  it('adds counts to the task detail and keeps FEAT-103 fields', async () => {
    const s = await fixture();
    const created = s.tasks.createWithExecution('Counted');
    const body = await (await fetch(`${s.base}/api/tasks/${created.task.id}`)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ task: { id: created.task.id }, executions: [{ id: created.execution.id, trigger: 'manual', retryOfExecutionId: null }], counts: { runs: 1, inputs: 0, outputs: 0, openRunId: created.execution.id } });
  });

  it('never logs the search term, and logs only counts and flags for a page', async () => {
    const s = await fixture();
    s.tasks.createWithExecution('Quarterly payroll for Anneliese');
    const page = await (await fetch(`${s.base}/api/tasks?q=${encodeURIComponent('Anneliese payroll')}&status=all`)).json() as { items: unknown[] };
    expect(page.items).toEqual([]);
    await fetch(`${s.base}/api/tasks?q=Anneliese`);
    const served = s.lines.filter((line) => line.includes('history page served'));
    expect(served.length).toBe(2);
    expect(JSON.parse(served[1]!)).toMatchObject({ count: 1, hasMore: false, group: 'all', hasQuery: true });
    expect(s.lines.join('\n')).not.toMatch(/Anneliese|payroll/);
  });
});

describe('GET /api/tasks/:taskId/runs', () => {
  it('pages 25 runs as 20 + 5, newest first, and answers an unknown task with the typed envelope', async () => {
    const s = await fixture();
    const created = s.tasks.createWithExecution('Many runs');
    let previous = created.execution.id;
    for (let index = 0; index < 24; index++) { s.executions.markSettled(previous, { status: 'failed' }); previous = s.executions.createRetry(previous, null).id; }
    const first = await (await fetch(`${s.base}/api/tasks/${created.task.id}/runs`)).json() as { items: { id: number; trigger: string }[]; nextCursor: string };
    const second = await (await fetch(`${s.base}/api/tasks/${created.task.id}/runs?cursor=${first.nextCursor}`)).json() as { items: { id: number }[]; hasMore: boolean };
    expect([first.items.length, second.items.length, second.hasMore]).toEqual([20, 5, false]);
    expect(first.items[0]).toMatchObject({ id: previous, trigger: 'rerun' });
    expect(second.items.at(-1)).toMatchObject({ id: created.execution.id, trigger: 'manual' });
    const unknown = await fetch(`${s.base}/api/tasks/999/runs`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'TASK_NOT_FOUND' } });
    expect((await fetch(`${s.base}/api/executions/999/record`)).status).toBe(404);
  });
});

describe('GET /api/executions/:id/record', () => {
  it('fills every section from the stored rows and leaks no payload, code, output, transcript payload, or path', async () => {
    const { h, base } = await fullyPopulated();
    const c = h.store.connection.client;
    const id = h.execution.id;
    // Sentinels in every place the record must not read.
    c.prepare("update script_run set stdout = 'STDOUT-SENTINEL', stderr = 'STDERR-SENTINEL' where execution_id = ?").run(id);
    c.prepare("update disclosure_consent set payload_snapshot = payload_snapshot || 'PAYLOAD-SENTINEL'").run();
    c.prepare("update code_file set content = content || '# CODE-SENTINEL'").run();
    h.registry.publish(id, { type: 'user_prompt', text: 'EVENT-SENTINEL', at: new Date().toISOString() });
    const response = await fetch(`${base}/api/executions/${id}/record`);
    const text = await response.text();
    const record = JSON.parse(text) as RunRecord;
    for (const sentinel of ['STDOUT-SENTINEL', 'STDERR-SENTINEL', 'PAYLOAD-SENTINEL', 'CODE-SENTINEL', 'EVENT-SENTINEL', 'QUESTION-SENTINEL', 'RATIONALE-SENTINEL', 'ANSWER-SENTINEL']) expect(text, sentinel).not.toContain(sentinel);
    for (const form of rootForms(h.store.root)) expect(text).not.toContain(form);

    const row = <T>(sql: string) => c.prepare(sql).get(id) as T;
    const finalVersion = row<{ id: number; digest: string; attempt: number }>('select id, content_digest digest, attempt from code_version where execution_id = ? and is_final = 1');
    const check = row<{ status: string; blocking: number; advisory: number }>('select status, blocking_count blocking, advisory_count advisory from verification_run where execution_id = ? order by id desc limit 1');
    expect(record.execution).toMatchObject({ id, status: 'completed', trigger: 'manual' });
    expect(record.inputs.map((input) => input.id)).toEqual(h.uploads.map((upload) => upload.id));
    expect(record.inputsReadByRun).toBe(true);
    expect(record.disclosure).toMatchObject({ provider: 'fake', model: 'fake-model', sendCount: row<{ n: number }>('select count(*) n from disclosure_transmission where execution_id = ?').n });
    expect(record.questions).toMatchObject({ total: 1, answered: 1, byPerson: 1, seeded: 0, defaulted: 0, declined: 0 });
    expect(record.code).toMatchObject({ id: finalVersion.id, attempt: finalVersion.attempt, digest: finalVersion.digest, shortDigest: finalVersion.digest.slice(0, 12), attemptCount: row<{ n: number }>('select count(*) n from generation_attempt where execution_id = ?').n });
    expect(record.checks).toMatchObject({ status: check.status, blockingCount: check.blocking, advisoryCount: check.advisory, runtime: expect.stringMatching(/^Python \S+ on \S+ · \d+ packages$/) });
    expect(record.approval).toMatchObject({ acknowledgedWarnings: Boolean(row<{ ack: number }>("select acknowledged_warnings ack from execution_approval where execution_id = ? and decision = 'approved'").ack), decidedAt: expect.any(String) });
    expect(record.scriptRun).toMatchObject({ status: 'succeeded', exitCode: 0, limitBreach: null, artifactCount: 1 });
    expect(record.outputs).toEqual({ count: 1 });
    expect(record.transcript.lastSeq).toBe(row<{ n: number }>('select max(seq) n from conversation_event where execution_id = ?').n);

    // A manifest digest that differs from the upload's: the run did not read exactly these files.
    c.prepare("update script_run set input_manifest = replace(input_manifest, substr(input_manifest, instr(input_manifest, '\"sha256\":\"') + 10, 4), 'ffff') where execution_id = ?").run(id);
    expect((await (await fetch(`${base}/api/executions/${id}/record`)).json() as RunRecord).inputsReadByRun).toBe(false);
    // A time-limit stop quotes FEAT-108's sentence verbatim.
    c.prepare("update script_run set status = 'timed_out', limit_breached = 'time' where execution_id = ?").run(id);
    expect((await (await fetch(`${base}/api/executions/${id}/record`)).json() as RunRecord).scriptRun?.limitBreach).toBe(describeLimitBreach('time'));
  });
});

describe('DELETE /api/tasks/:taskId', () => {
  it('refuses a live task, then removes rows and reports the whole task', async () => {
    const s = await fixture();
    const created = s.tasks.createWithExecution('Delete me');
    const open = await fetch(`${s.base}/api/tasks/${created.task.id}`, { method: 'DELETE' });
    expect(open.status).toBe(409);
    expect(await open.json()).toMatchObject({ error: { code: 'TASK_HAS_OPEN_RUN' } });
    expect(s.tasks.getById(created.task.id)).toBeDefined();
    s.executions.markSettled(created.execution.id, { status: 'failed' });
    const response = await fetch(`${s.base}/api/tasks/${created.task.id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: created.task.id, removed: { runs: 1, inputs: 0, outputs: 0 }, filesPendingRemoval: 0 });
    expect(s.tasks.getById(created.task.id)).toBeUndefined();
    const again = await fetch(`${s.base}/api/tasks/${created.task.id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: 'TASK_NOT_FOUND' } });
    expect((await fetch(`${s.base}/api/tasks/999`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers a foreign Origin with 403 before any row is read', async () => {
    const s = await fixture();
    const created = s.tasks.createWithExecution('Keep me');
    s.executions.markSettled(created.execution.id, { status: 'failed' });
    const deleting = vi.spyOn(s.deletion, 'delete'); const reading = vi.spyOn(s.tasks, 'getById');
    const refused = await fetch(`${s.base}/api/tasks/${created.task.id}`, { method: 'DELETE', headers: { origin: 'https://attacker.example' } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    expect(deleting).not.toHaveBeenCalled(); expect(reading).not.toHaveBeenCalled();
    expect(s.tasks.getById(created.task.id)).toBeDefined();
  });

  it('logs counts only — never the task name, a filename, or the data root — and a retry of a deleted run is EXECUTION_NOT_FOUND', async () => {
    const { logger, lines } = capturingLogger();
    const full = await fullyPopulated({ prompt: 'Payroll for Anneliese Moreau', logger });
    const { h, base } = full;
    const deleted = await fetch(`${base}/api/tasks/${h.task.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const body = await deleted.text();
    for (const form of rootForms(h.store.root)) expect(body).not.toContain(form);
    const log = lines.join('\n');
    expect(log).toContain('task deleted');
    for (const secret of ['Anneliese', 'Moreau', h.uploads[0]!.originalFilename, 'totals.csv', ...rootForms(h.store.root)]) expect(log, secret).not.toContain(secret);
    const retry = await fetch(`${base}/api/executions/${h.execution.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(retry.status).toBe(404);
    expect(await retry.json()).toMatchObject({ error: { code: 'EXECUTION_NOT_FOUND' } });
  });
});
