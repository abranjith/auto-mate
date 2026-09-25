import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import pino from 'pino';
import { Value } from '@sinclair/typebox/value';
import { UPLOAD_LIMIT_DEFAULTS, UploadResponseSchema, UploadListResponseSchema, type UploadResponse } from '@automate/core';
import { FakeAgentProvider } from '../agent/testing/fake-agent-provider';
import { createApp } from '../app';
import type { IngestionConfig, ServerConfig } from '../config/env';
import { PassthroughRunStrategy, TaskSessionRegistry } from '../conversation/index';
import { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import { UploadRepository } from '../db/repositories/upload-repository';
import { ProfileService, UploadFileStore, UploadService } from '../ingestion/index';
import { createTempStore, type TempStore } from './support/ingestion-fixtures';

let store: TempStore;
let server: Server;
let base: string;
let uploadRows: UploadRepository;
const config: ServerConfig = { host: '127.0.0.1', port: 4317, logLevel: 'silent', maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };
const limits: IngestionConfig = { ...UPLOAD_LIMIT_DEFAULTS, maxUploadBytes: 64 * 1024 };

beforeEach(async () => {
  store = createTempStore('automate-upload-route-');
  const logger = pino({ level: 'silent' });
  const tasks = new TaskRepository(store.connection);
  const executions = new ExecutionRepository(store.connection);
  const events = new ConversationEventRepository(store.connection);
  uploadRows = new UploadRepository(store.connection);
  const profiles = new UploadProfileRepository(store.connection);
  const files = new UploadFileStore(store.paths);
  const registry = new TaskSessionRegistry({
    provider: new FakeAgentProvider(),
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths: store.paths,
    model: () => ({ provider: 'fake', id: 'fake' }),
    auth: () => ({ mode: 'managed' }),
    logger,
    maxConcurrentExecutions: 5,
  });
  const uploads = new UploadService({ uploads: uploadRows, profiles, store: files, profiler: new ProfileService({ uploads: uploadRows, profiles, store: files, limits, logger }), limits, logger });
  const app = createApp({ logger, dataRoot: store.root, version: 'test', paths: store.paths, getSchemaVersion: () => '3', conversation: { tasks, executions, events, registry }, serverConfig: config, ingestion: { uploads } });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  config.port = address.port;
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.dispose();
});

const count = (table: string) => (store.connection.client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;

async function postFile(name: string, content: string | Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([typeof content === 'string' ? content : Uint8Array.from(content)]), name);
  return fetch(`${base}/api/uploads`, { method: 'POST', body: form, headers });
}

async function uploaded(name = 'sales.csv', content = 'id,amount,city\n1,3.5,Paris\n2,4,Oslo\n'): Promise<UploadResponse> {
  const response = await postFile(name, content);
  expect(response.status).toBe(201);
  return (await response.json()) as UploadResponse;
}

function createTask(uploadIds: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ prompt: 'Summarize by city', uploadIds }) });
}

describe('upload REST API', () => {
  it('receives, profiles, and stages a CSV, returning a schema-valid body with no absolute path', async () => {
    const response = await postFile('Données été.csv', 'id,amount,city\n1,3.5,Paris\n2,4,Oslo\n');
    expect(response.status).toBe(201);
    const text = await response.text();
    const body = JSON.parse(text) as UploadResponse;
    expect(Value.Errors(UploadResponseSchema, body).First()).toBeUndefined();
    expect(body.upload).toMatchObject({ originalFilename: 'Données été.csv', format: 'csv', profileStatus: 'profiled', taskId: null });
    expect(body.upload.filePath).toBe(`uploads/staged/${body.upload.id}/${body.upload.id}-Donnees-ete.csv`);
    expect(body.profiles[0]!.columns.map(({ name }) => name)).toEqual(['id', 'amount', 'city']);
    expect(body.disclosure?.tables[0]!.sampleRows).toHaveLength(2);
    expect(existsSync(path.join(store.root, ...body.upload.filePath.split('/')))).toBe(true);
    for (const needle of [store.root, store.root.replace(/\\/g, '\\\\'), store.root.replace(/\\/g, '/')]) expect(text).not.toContain(needle);
  });

  it('reads one upload back and answers an unknown id with the UPLOAD_NOT_FOUND envelope and its correlation id', async () => {
    const created = await uploaded();
    const found = await fetch(`${base}/api/uploads/${created.upload.id}`);
    expect(await found.json()).toEqual(created);
    const missing = await fetch(`${base}/api/uploads/999`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: { code: string; correlationId: string } };
    expect(body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect(body.error.correlationId).toBe(missing.headers.get('x-correlation-id'));
    expect((await fetch(`${base}/api/uploads/abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/uploads/1?x=1`)).status).toBe(400);
  });

  it('deletes a staged upload with its file, and refuses to delete an attached one', async () => {
    const staged = await uploaded();
    const deleted = await fetch(`${base}/api/uploads/${staged.upload.id}`, { method: 'DELETE' });
    expect(await deleted.json()).toEqual({ id: staged.upload.id, deleted: true });
    expect(existsSync(path.join(store.paths.stagedUploadsDir, String(staged.upload.id)))).toBe(false);
    expect(count('upload')).toBe(0);
    const attached = await uploaded();
    expect((await createTask([attached.upload.id])).status).toBe(201);
    const refused = await fetch(`${base}/api/uploads/${attached.upload.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('UPLOAD_ALREADY_ATTACHED');
  });

  it('rejects a foreign Origin before anything is written', async () => {
    const response = await postFile('a.csv', 'a,b\n1,2\n', { origin: 'http://evil.example' });
    expect(response.status).toBe(403);
    expect(count('upload')).toBe(0);
    expect(readdirSync(store.paths.stagedUploadsDir)).toEqual([]);
    const created = await uploaded();
    const deleted = await fetch(`${base}/api/uploads/${created.upload.id}`, { method: 'DELETE', headers: { origin: 'http://evil.example' } });
    expect(deleted.status).toBe(403);
    expect(count('upload')).toBe(1);
  });

  it.each([
    ['too large', 'big.csv', 'x'.repeat(64 * 1024 + 1), 413, 'UPLOAD_TOO_LARGE'],
    ['empty', 'empty.csv', '', 400, 'FILE_EMPTY'],
    ['legacy .xls', 'old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 415, 'UNSUPPORTED_FILE_FORMAT'],
  ] as const)('answers a %s file with its typed envelope and keeps nothing', async (_label, name, content, status, code) => {
    const response = await postFile(name, content);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
    expect(count('upload')).toBe(0);
    expect(readdirSync(store.paths.stagedUploadsDir)).toEqual([]);
  });

  it('answers a file that cannot be profiled with 422, and keeps the failed row and its file', async () => {
    const response = await postFile('broken.csv', 'id,note\n1,"never closed\n');
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'PARSE_FAILED', message: expect.stringContaining('line 2') });
    const [row] = store.connection.client.prepare('SELECT id, profile_status, file_path FROM upload').all() as { id: number; profile_status: string; file_path: string }[];
    expect(row!.profile_status).toBe('failed');
    expect(existsSync(path.join(store.root, ...row!.file_path.split('/')))).toBe(true);
  });
});

describe('attaching uploads at task creation', () => {
  it('attaches two uploads, moves both files, and lists them under the task', async () => {
    const first = await uploaded('a.csv');
    const second = await uploaded('b.csv');
    const response = await createTask([first.upload.id, second.upload.id]);
    expect(response.status).toBe(201);
    const { task } = (await response.json()) as { task: { id: number } };
    const listed = await fetch(`${base}/api/tasks/${task.id}/uploads`);
    const body = (await listed.json()) as { uploads: UploadResponse[] };
    expect(Value.Check(UploadListResponseSchema, body)).toBe(true);
    expect(body.uploads.map(({ upload }) => [upload.id, upload.taskId, upload.filePath])).toEqual([
      [first.upload.id, task.id, `uploads/${task.id}/${first.upload.id}-a.csv`],
      [second.upload.id, task.id, `uploads/${task.id}/${second.upload.id}-b.csv`],
    ]);
    for (const { upload } of body.uploads) expect(existsSync(path.join(store.root, ...upload.filePath.split('/')))).toBe(true);
    expect(readdirSync(store.paths.stagedUploadsDir)).toEqual([]);
  });

  it('still creates text-only tasks', async () => {
    expect((await createTask(undefined)).status).toBe(201);
    expect((await createTask([])).status).toBe(201);
  });

  it('rejects an unknown id and creates no task', async () => {
    const valid = await uploaded();
    const response = await createTask([valid.upload.id, 999]);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('UPLOAD_NOT_FOUND');
    expect([count('task'), count('execution')]).toEqual([0, 0]);
    expect(uploadRows.getById(valid.upload.id)?.taskId).toBeNull();
  });

  it('rejects an already-attached id', async () => {
    const valid = await uploaded();
    expect((await createTask([valid.upload.id])).status).toBe(201);
    const again = await createTask([valid.upload.id]);
    expect(again.status).toBe(409);
    expect(count('task')).toBe(1);
  });

  it('rejects an unprofiled or failed upload', async () => {
    const pending = uploadRows.createStaged({ originalFilename: 'p.csv', storedFilename: '1-p.csv', filePath: 'uploads/staged/1/1-p.csv', format: 'csv', mimeType: 'text/csv', byteSize: 1, sha256: 'a'.repeat(64) });
    const pendingResponse = await createTask([pending.id]);
    expect(pendingResponse.status).toBe(400);
    expect(((await pendingResponse.json()) as { error: { message: string } }).error.message).toMatch(/still being analyzed/);
    await postFile('broken.csv', 'id,note\n1,"never closed\n');
    const failed = (store.connection.client.prepare("SELECT id FROM upload WHERE profile_status = 'failed'").get() as { id: number }).id;
    const failedResponse = await createTask([failed]);
    expect(failedResponse.status).toBe(400);
    expect(((await failedResponse.json()) as { error: { message: string } }).error.message).toMatch(/could not be read/);
    expect(count('task')).toBe(0);
  });

  it('fails schema validation for six ids with a message about files', async () => {
    const response = await createTask([1, 2, 3, 4, 5, 6]);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/at most 5 files/);
  });

  it('answers the task upload list for an unknown task with TASK_NOT_FOUND', async () => {
    expect((await fetch(`${base}/api/tasks/77/uploads`)).status).toBe(404);
  });
});
