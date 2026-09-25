import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import pino from 'pino';
import { Value } from '@sinclair/typebox/value';
import {
  DISCLOSURE_MAX_BYTES,
  UPLOAD_LIMIT_DEFAULTS,
  UploadResponseSchema,
  buildDisclosurePayload,
  type TableProfile,
  type UploadResponse,
} from '@automate/core';
import { FakeAgentProvider } from '../agent/testing/fake-agent-provider';
import { createApp } from '../app';
import type { ServerConfig } from '../config/env';
import { PassthroughRunStrategy, TaskSessionRegistry } from '../conversation/index';
import { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import { UploadRepository } from '../db/repositories/upload-repository';
import { ProfileService, UploadFileStore, UploadService } from '../ingestion/index';
import { writeCorpus, type Fixture } from './fixtures/ingestion/corpus';
import { createTempStore, type TempStore } from './support/ingestion-fixtures';

/** The whole corpus, including the 300,001-row workbook, must stay fast enough that nobody skips it. */
const CORPUS_BUDGET_MS = 120_000;

let store: TempStore;
let corpusDir: string;
let fixtures: Fixture[];
let server: Server;
let base: string;
let started: number;
let profiler: ProfileService;
/** Profiles as built in memory, before persistence, by upload id. */
const built = new Map<number, TableProfile[]>();
const config: ServerConfig = { host: '127.0.0.1', port: 4317, logLevel: 'silent', maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };

beforeAll(async () => {
  started = Date.now();
  store = createTempStore('automate-e2e-');
  corpusDir = mkdtempSync(path.join(tmpdir(), 'automate-corpus-'));
  fixtures = await writeCorpus(corpusDir, true);
  const logger = pino({ level: 'silent' });
  const tasks = new TaskRepository(store.connection);
  const executions = new ExecutionRepository(store.connection);
  const events = new ConversationEventRepository(store.connection);
  const uploads = new UploadRepository(store.connection);
  const profiles = new UploadProfileRepository(store.connection);
  const files = new UploadFileStore(store.paths);
  const limits = { ...UPLOAD_LIMIT_DEFAULTS };
  profiler = new ProfileService({ uploads, profiles, store: files, limits, logger });
  const profile = profiler.profile.bind(profiler);
  vi.spyOn(profiler, 'profile').mockImplementation(async (id) => {
    const result = await profile(id);
    built.set(id, result);
    return result;
  });
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
  const service = new UploadService({ uploads, profiles, store: files, profiler, limits, logger });
  const app = createApp({ logger, dataRoot: store.root, version: 'test', paths: store.paths, getSchemaVersion: () => '3', conversation: { tasks, executions, events, registry }, serverConfig: config, ingestion: { uploads: service } });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  config.port = address.port;
  base = `http://127.0.0.1:${address.port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.dispose();
  rmSync(corpusDir, { recursive: true, force: true });
});

async function post(fixture: Fixture): Promise<{ status: number; text: string }> {
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(readFileSync(fixture.file))]), path.basename(fixture.file));
  const response = await fetch(`${base}/api/uploads`, { method: 'POST', body: form });
  return { status: response.status, text: await response.text() };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function assertNoAbsolutePath(text: string): void {
  for (const root of [store.root, corpusDir]) {
    for (const needle of [root, root.replace(/\\/g, '\\\\'), root.replace(/\\/g, '/')]) expect(text).not.toContain(needle);
  }
  expect(text).not.toMatch(/"[A-Za-z]:\\\\/);
}

function assertCardinalityInvariant(): void {
  const leaks = store.connection.client
    .prepare('SELECT count(*) AS count FROM upload_column WHERE is_high_cardinality = 1 AND (distinct_count IS NOT NULL OR top_values IS NOT NULL)')
    .get() as { count: number };
  expect(leaks.count).toBe(0);
}

describe('ingestion end to end', () => {
  it('drives every small fixture through route → intake → profile → persist → payload', async () => {
    for (const fixture of fixtures.filter(({ large }) => !large)) {
      const { status, text } = await post(fixture);
      assertNoAbsolutePath(text);
      const body = JSON.parse(text) as UploadResponse & { error?: { code: string } };
      if ('error' in fixture.expect) {
        expect({ fixture: fixture.name, code: body.error?.code }).toEqual({ fixture: fixture.name, code: fixture.expect.error });
        continue;
      }
      expect({ fixture: fixture.name, status }).toEqual({ fixture: fixture.name, status: 201 });
      expect(Value.Check(UploadResponseSchema, body)).toBe(true);
      expect(body.profiles).toHaveLength(fixture.expect.tables);
      expect(bytes(body.disclosure)).toBeLessThanOrEqual(DISCLOSURE_MAX_BYTES);
      fixture.expect.check?.(body.profiles);
      const codes = body.profiles.flatMap((profile) => profile.notes.map(({ code }) => code));
      for (const note of fixture.expect.notes ?? []) expect({ fixture: fixture.name, has: codes.includes(note), note }).toEqual({ fixture: fixture.name, has: true, note });
    }
    assertCardinalityInvariant();
  }, 60_000);

  it('rebuilds an identical payload from the persisted profile (persist-then-rebuild equals build-then-persist)', async () => {
    for (const fixture of fixtures.filter((candidate) => !candidate.large && !('error' in candidate.expect))) {
      const body = JSON.parse((await post(fixture)).text) as UploadResponse;
      const inMemory = built.get(body.upload.id)!;
      const direct = buildDisclosurePayload(
        { originalFilename: body.upload.originalFilename, format: body.upload.format, byteSize: body.upload.byteSize, sha256: body.upload.sha256, encoding: body.upload.encoding },
        inMemory,
      );
      expect(body.profiles).toEqual(inMemory);
      expect(JSON.stringify(body.disclosure)).toBe(JSON.stringify(direct));
    }
  }, 60_000);

  it('produces byte-identical payloads when the same file is uploaded twice (seeded sampling is deterministic)', async () => {
    const fixture = fixtures.find(({ name }) => name === 'clean comma CSV')!;
    const first = JSON.parse((await post(fixture)).text) as UploadResponse;
    const second = JSON.parse((await post(fixture)).text) as UploadResponse;
    expect(second.upload.id).not.toBe(first.upload.id);
    expect(JSON.stringify(second.disclosure)).toBe(JSON.stringify(first.disclosure));
  });

  it('profiles the 300,001-row workbook inside the parse timeout with a bounded heap', async () => {
    setFlagsFromString('--expose-gc');
    (runInNewContext('gc') as () => void)();
    const fixture = fixtures.find(({ large }) => large)!;
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 25);
    const begun = Date.now();
    const { status, text } = await post(fixture).finally(() => clearInterval(sampler));
    expect(status).toBe(201);
    expect(Date.now() - begun).toBeLessThan(UPLOAD_LIMIT_DEFAULTS.parseTimeoutMs);
    const body = JSON.parse(text) as UploadResponse;
    if (!('error' in fixture.expect)) fixture.expect.check?.(body.profiles);
    expect(bytes(body.disclosure)).toBeLessThanOrEqual(DISCLOSURE_MAX_BYTES);
    expect(peak - baseline).toBeLessThan(300 * 1024 * 1024);
    assertCardinalityInvariant();
  }, 120_000);

  it('keeps the whole corpus inside its runtime budget', () => {
    expect(Date.now() - started).toBeLessThan(CORPUS_BUDGET_MS);
  });
});
