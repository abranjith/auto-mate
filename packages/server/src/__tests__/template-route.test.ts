import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { CompatibilityResponseSchema, DeleteTemplateResponseSchema, SavePreviewResponseSchema, TaskHistoryPageSchema, TemplateDetailResponseSchema, describeTrigger } from '@automate/core';
import { createApp } from '../app';
import type { VerificationHarness } from './support/verification-harness';
import { acceptedHarness, reuseServices, runSavedToCompletion, stageSimilar, type ReuseServices } from './support/reuse-harness';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnesses: VerificationHarness[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

async function serve(h: VerificationHarness, s: ReuseServices) {
  const config = { host: '127.0.0.1', port: 0, logLevel: 'silent' as const, maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };
  const app = createApp({ logger: h.logger, dataRoot: h.store.root, version: 'test', paths: h.store.paths, getSchemaVersion: () => '11', serverConfig: config, conversation: { tasks: h.repos.tasks, executions: h.repos.executions, events: h.repos.events, registry: h.registry, disclosure: h.disclosure, preflight: h.preflight, consents: h.repos.consents }, templates: { templates: s.templates, reuse: h.repos.reuse, history: s.history, executions: h.repos.executions, save: s.save, compatibility: s.compatibility, runs: s.runs, repairs: s.repairs } });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener.');
  config.port = address.port;
  const base = `http://127.0.0.1:${address.port}`;
  const send = (method: string, url: string, body?: unknown, origin = base) => fetch(`${base}/api${url}`, { method, headers: { 'content-type': 'application/json', origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = async (url: string) => { const response = await fetch(`${base}/api${url}`); return { status: response.status, body: await response.json() as unknown }; };
  return { base, send, get };
}
async function setup() {
  const h = await acceptedHarness(); harnesses.push(h);
  const s = reuseServices(h);
  return { h, s, http: await serve(h, s) };
}
function csv(header: string, rowCount = 30): string {
  const lines = [header];
  for (let index = 1; index <= rowCount; index += 1) lines.push(`${4000 + index},${['North', 'South'][index % 2]},${index + 0.5},r-${index}`);
  return `${lines.join('\n')}\n`;
}

describe('saved-task routes', () => {
  it('saves over HTTP, previews what is kept, and guards the write', async () => {
    const { h, http } = await setup();
    const preview = await http.get(`/executions/${h.execution.id}/save-preview`);
    expect(Value.Check(SavePreviewResponseSchema, preview.body)).toBe(true);
    expect(preview.body).toMatchObject({ saveable: true, defaultName: h.task.name, keeps: { inputs: [{ label: h.upload!.originalFilename, requiredColumns: ['region'] }] } });
    expect((await http.send('POST', `/executions/${h.execution.id}/save`, {}, 'http://elsewhere.invalid')).status).toBe(403);
    expect((await http.send('POST', `/executions/${h.execution.id}/save`, { name: 'x'.repeat(121) })).status).toBe(400);
    expect((await http.send('POST', `/executions/${h.execution.id}/save`, { extra: true })).status).toBe(400);
    const saved = await http.send('POST', `/executions/${h.execution.id}/save`, { name: 'Monthly' });
    expect(saved.status).toBe(201);
    const again = await http.send('POST', `/executions/${h.execution.id}/save`, {});
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'EXECUTION_ALREADY_SAVED' } });
  });

  it('answers an incompatible file with a 200 report, and refuses to start it with 409', async () => {
    const { h, s, http } = await setup();
    const template = s.save.save(h.execution.id, { name: 'Monthly' });
    const upload = await stageSimilar(h, 'renamed.csv', csv('order_id,area,amount,ref'));
    const check = await http.get(`/templates/${template.template.id}/compatibility?uploadIds=${upload.id}&timeZone=UTC`);
    expect(check.status).toBe(200);
    expect(Value.Check(CompatibilityResponseSchema, check.body)).toBe(true);
    const body = check.body as { report: { status: string }; digest: string; asOf: unknown };
    expect(body.report.status).toBe('incompatible');
    const start = await http.send('POST', `/templates/${template.template.id}/runs`, { uploadIds: [upload.id], compatibilityDigest: body.digest, asOf: body.asOf });
    expect(start.status).toBe(409);
    expect(await start.json()).toMatchObject({ error: { code: 'INPUTS_INCOMPATIBLE' } });
    for (const query of ['uploadIds=abc', `uploadIds=${upload.id},${upload.id}`, `uploadIds=${upload.id}&extra=2`, `uploadIds=${upload.id}&asOfDate=2999-01-01&timeZone=UTC`, `uploadIds=${upload.id}&timeZone=Mars/Olympus`]) expect((await http.get(`/templates/${template.template.id}/compatibility?${query}`)).status, query).toBe(400);
    expect((await http.get(`/templates/999/compatibility?uploadIds=${upload.id}`)).status).toBe(404);
  });

  it('serves the list, detail, runs, and revision, with code only on the revision route', async () => {
    const { h, s, http } = await setup();
    const template = s.save.save(h.execution.id, { name: 'Monthly' });
    const upload = await stageSimilar(h, 'oct.csv', csv('order_id,region,amount,ref'));
    const first = await runSavedToCompletion(h, s, template.template.id, upload.id);
    const replay = s.runs.replay(first.execution.id);
    await h.settledPhases(replay.id);
    const list = await http.get('/templates');
    expect(list.body).toMatchObject({ items: [{ id: template.template.id, name: 'Monthly', currentRevisionNumber: 1, revisionCount: 1, runCount: 1 }], hasMore: false });
    const detail = await http.get(`/templates/${template.template.id}`);
    expect(Value.Check(TemplateDetailResponseSchema, detail.body)).toBe(true);
    const runs = await http.get(`/templates/${template.template.id}/runs`);
    expect(Value.Check(TaskHistoryPageSchema, runs.body)).toBe(true);
    expect((runs.body as { items: { task: { id: number } }[] }).items.map((item) => item.task.id)).toEqual([first.task.id]);
    const code = s.templates.listFiles(template.revision.id).find((file) => file.path === 'main.py')!.content;
    for (const url of ['/templates', `/templates/${template.template.id}`, `/templates/${template.template.id}/runs`, `/executions/${h.execution.id}/save-preview`]) expect(JSON.stringify((await http.get(url)).body), url).not.toContain(code);
    expect(JSON.stringify((await http.get(`/template-revisions/${template.revision.id}`)).body)).toContain(JSON.stringify(code).slice(1, -1));
    for (const url of ['/templates/999', '/template-revisions/999', '/templates/999/runs']) expect((await http.get(url)).status, url).toBe(404);
    for (const url of ['/templates?limit=51', '/templates?cursor=abc', '/templates?sort=name']) expect((await http.get(url)).status, url).toBe(400);
  });

  it('deletes a saved task and keeps its runs, labelled from the snapshots', async () => {
    const { h, s, http } = await setup();
    const template = s.save.save(h.execution.id, { name: 'Monthly' });
    const upload = await stageSimilar(h, 'oct.csv', csv('order_id,region,amount,ref'));
    const run = await runSavedToCompletion(h, s, template.template.id, upload.id);
    const artifacts = h.repos.artifacts.listByExecution(run.execution.id).length;
    expect((await http.send('DELETE', `/templates/${template.template.id}`, undefined, 'http://elsewhere.invalid')).status).toBe(403);
    const removed = await http.send('DELETE', `/templates/${template.template.id}`);
    const body = await removed.json();
    expect(Value.Check(DeleteTemplateResponseSchema, body)).toBe(true);
    expect(body).toEqual({ templateId: template.template.id, removed: { revisions: 1 }, runsKept: 1 });
    expect(h.repos.executions.getById(run.execution.id)!.status).toBe('completed');
    expect(h.repos.artifacts.listByExecution(run.execution.id)).toHaveLength(artifacts);
    const timeline = s.history.listRuns(run.task.id, { limit: 20 }).items[0]!;
    expect(timeline.reuse).toEqual({ kind: 'run', templateId: null, templateName: 'Monthly', revisionNumber: 1 });
    expect(describeTrigger(timeline.trigger, { hasGuidance: false, reuseKind: timeline.reuse?.kind })).toBe('Ran your saved task');
    expect((await http.send('DELETE', `/templates/${template.template.id}`)).status).toBe(404);
  });
});

describe('FEAT-111 boundaries', () => {
  const files = (root: string): string[] => readdirSync(root).flatMap((name) => { const full = path.join(root, name); return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : []; });
  it('no saved-task module imports the agent or builds a prompt', () => {
    for (const file of files(path.join(SRC, 'reuse'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from '\.\.\/agent|assemblePromptContext/);
  });
  it('packages/core/src/reuse imports no Node built-in', () => {
    for (const file of files(path.join(SRC, '..', '..', 'core', 'src', 'reuse'))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from 'node:/);
  });
  it('only ExecutionInputs turns an upload\'s stored name into a path a script reads', () => {
    for (const dir of ['generation', 'verification', 'execution']) for (const file of files(path.join(SRC, dir)).filter((name) => !name.endsWith('execution-inputs.ts'))) {
      for (const line of readFileSync(file, 'utf8').split('\n').filter((text) => text.includes('storedFilename'))) expect(line, file).not.toMatch(/join\(|resolveWithin\(|resolve\(|`[^`]*\$\{[^}]*storedFilename/);
    }
  });
});
