import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { CHECK_KEYS, buildIntentDigest, type ConversationEvent, type ServerToClientMessage } from '@automate/core';
import { createApp } from '../app';
import type { ServerConfig } from '../config/env';
import { attachExecutionSocket } from '../ws/index';
import type { FakePythonRun } from '../execution/testing/fake-python-runner';
import { createVerificationHarness, type VerificationHarness } from './support/verification-harness';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const producing: FakePythonRun = { onRun: (request) => { writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'totals.csv'), 'a\n'); writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'T', description: '' }] })); } };

/** A harness at the approval gate, served over HTTP and WebSocket with the whole FEAT-107 router mounted. */
async function served() {
  const h = await createVerificationHarness({ pythonRuns: [{}, {}, producing] });
  cleanup.push(() => h.dispose());
  await h.runToGate();
  const config: ServerConfig = { host: '127.0.0.1', port: 0, logLevel: 'silent', maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };
  const app = createApp({ logger: h.logger, dataRoot: h.store.root, version: 'test', paths: h.store.paths, getSchemaVersion: () => '6', conversation: { tasks: h.repos.tasks, executions: h.repos.executions, events: h.repos.events, registry: h.registry }, serverConfig: config, generation: { service: h.service }, verification: { verification: h.verification, intents: h.intents, approval: h.approval, runs: h.scriptRun, review: h.review, assertCapacity: () => h.registry.assertCapacity() } });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  config.port = address.port;
  const detach = attachExecutionSocket(server, { executions: h.repos.executions, events: h.repos.events, registry: h.registry, config, logger: h.logger });
  cleanup.push(() => new Promise<void>((resolve) => { detach(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${address.port}`;
  const bodies: string[] = [];
  /** Every response body is kept, so the path scan covers all six routes. */
  async function call(method: string, route: string, body?: unknown, origin?: string) {
    const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown>, correlationId: response.headers.get('x-correlation-id') };
  }
  return { h, base, call, bodies, port: address.port };
}
const count = (h: VerificationHarness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const until = async (predicate: () => boolean) => { for (let spin = 0; spin < 400 && !predicate(); spin += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };

describe('verification routes', () => {
  it('serves the report with checks in policy order, and a typed envelope for an unknown id', async () => {
    const { h, call } = await served();
    const report = await call('GET', `/api/executions/${h.execution.id}/verification`);
    expect(report.status).toBe(200);
    expect((report.json.checks as { checkKey: string }[]).map(({ checkKey }) => checkKey)).toEqual([...CHECK_KEYS]);
    expect(report.json).toMatchObject({ status: 'passed', runtimeDescription: 'Python 3.12.4 on Linux (x64)' });
    const missing = await call('GET', '/api/executions/999/verification');
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: { code: 'EXECUTION_NOT_FOUND', message: expect.any(String), correlationId: missing.correlationId } });
    expect((await call('GET', '/api/executions/abc/intent')).status).toBe(400);
  });

  it('serves an intent whose digest matches a server-side recomputation', async () => {
    const { h, call } = await served();
    const { json } = await call('GET', `/api/executions/${h.execution.id}/intent`);
    expect(json.intentDigest).toBe(buildIntentDigest(json.intent as never));
    expect(json.intentDigest).toBe(h.intents.buildRunIntent(h.execution.id).intentDigest);
  });

  it('rejects a mismatched digest with APPROVAL_INTENT_MISMATCH and the response correlation id', async () => {
    const { h, call } = await served();
    const response = await call('POST', `/api/executions/${h.execution.id}/approval`, { intentDigest: 'f'.repeat(64), decision: 'approved', acknowledgedWarnings: true });
    expect(response.status).toBe(409);
    expect(response.json).toEqual({ error: { code: 'APPROVAL_INTENT_MISMATCH', message: expect.stringMatching(/out of date/), correlationId: response.correlationId } });
    expect(count(h, 'execution_approval')).toBe(0);
    expect((await call('POST', `/api/executions/${h.execution.id}/approval`, { decision: 'approved' })).status).toBe(400);
  });

  it.each([['approval', { intentDigest: 'a'.repeat(64), decision: 'approved', acknowledgedWarnings: true }], ['verify', {}], ['review', { verdict: 'accepted' }], ['abort', undefined]])('refuses a foreign Origin on /%s before anything is written', async (route, body) => {
    const { h, call } = await served();
    const before = [count(h, 'execution_approval'), count(h, 'verification_run'), count(h, 'script_run'), h.repos.executions.getById(h.execution.id)?.status];
    const response = await call('POST', `/api/executions/${h.execution.id}/${route}`, body, 'http://evil.example');
    expect(response.status).toBe(403);
    expect((response.json.error as { code: string }).code).toBe('ORIGIN_REJECTED');
    expect([count(h, 'execution_approval'), count(h, 'verification_run'), count(h, 'script_run'), h.repos.executions.getById(h.execution.id)?.status]).toEqual(before);
  });

  it('rejects 2,001 characters of feedback with VALIDATION_ERROR', async () => {
    const { h, call } = await served();
    const response = await call('POST', `/api/executions/${h.execution.id}/review`, { verdict: 'rejected', feedback: 'x'.repeat(2_001) });
    expect(response.status).toBe(400);
    expect((response.json.error as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('drives approve → run → review over HTTP, with no absolute path in any response, and delivers events in persisted order', async () => {
    const { h, call, bodies, port } = await served();
    const live: ConversationEvent[] = [];
    const lastSeq = h.repos.events.maxSeq(h.execution.id);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws/executions/${h.execution.id}?afterSeq=${lastSeq}`);
    socket.on('message', (data) => { const message = JSON.parse(String(data)) as ServerToClientMessage; if (message.type === 'event') live.push(message.event); });
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    cleanup.push(async () => { socket.close(); });
    await call('GET', `/api/executions/${h.execution.id}/verification`);
    const intent = await call('GET', `/api/executions/${h.execution.id}/intent`);
    const approved = await call('POST', `/api/executions/${h.execution.id}/approval`, { intentDigest: intent.json.intentDigest, decision: 'approved', acknowledgedWarnings: true });
    expect(approved.json).toMatchObject({ outcome: 'approved', status: 'executing' });
    await until(() => h.repos.executions.getById(h.execution.id)?.status === 'awaiting_review');
    const run = await call('GET', `/api/executions/${h.execution.id}/run`);
    expect(run.json).toMatchObject({ status: 'succeeded', declaredOutputs: [expect.objectContaining({ filename: 'totals.csv', present: true })] });
    expect((await call('POST', `/api/executions/${h.execution.id}/review`, { verdict: 'accepted' })).json).toEqual({ status: 'completed', retryExecutionId: null });
    expect((await call('POST', `/api/executions/${h.execution.id}/verify`, {})).status).toBe(400);
    await until(() => live.some((event) => event.type === 'review_decided') && live.at(-1)?.type === 'state_changed');
    const stored = h.repos.events.listAfter(h.execution.id, lastSeq, 100).events;
    expect(live).toEqual(stored);
    expect(stored.map(({ type }) => type)).toEqual(['approval_decided', 'state_changed', 'run_finished', 'state_changed', 'review_decided', 'state_changed']);
    const uploads = h.store.paths.uploadsDir;
    for (const body of bodies) for (const needle of [h.store.root, h.store.root.replace(/\\/g, '/'), h.store.root.replace(/\\/g, '\\\\'), uploads.replace(/\\/g, '\\\\')]) expect(body).not.toContain(needle);
  });
});
