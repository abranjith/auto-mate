import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import path from 'node:path';
import pino from 'pino';
import { WebSocket } from 'ws';
import { HISTORY_STATUS_GROUPS, INTERRUPTION_MESSAGES, INTERRUPTED_ON_RESTART, SURVIVES_RESTART } from '@automate/core';
import { createApp } from '../app';
import { ArtifactService } from '../artifacts/artifact-service';
import { FakeAgentProvider } from '../agent/testing/fake-agent-provider';
import { getArtifactConfig, getServerConfig } from '../config/env';
import { ArtifactRepository } from '../db/repositories/artifact-repository';
import { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import { DisclosureConsentRepository } from '../db/repositories/disclosure-consent-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { HistoryRepository } from '../db/repositories/history-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { TaskSessionRegistry } from '../conversation/task-session-registry';
import { PassthroughRunStrategy } from '../conversation/run-strategy';
import { RetentionSweeper } from '../history/retention-sweeper';
import { TaskDeletionService } from '../history/task-deletion-service';
import { attachExecutionSocket } from '../ws/index';
import { TASK_OWNED_TREES } from '../history/task-owned-trees';
import { createTempStore, type TempStore } from './support/ingestion-fixtures';
import { createVerificationHarness, type VerificationHarness } from './support/verification-harness';
import type { FakePythonRun } from '../execution/testing/fake-python-runner';
import { readZip } from './support/zip-reader';
import { startFullApp, type FullApp } from './support/history-app';
import { ArtifactSweeper } from '../artifacts/artifact-sweeper';
import { StagedUploadSweeper } from '../ingestion/staged-upload-sweeper';
import { UploadFileStore } from '../ingestion/upload-file-store';
import { UploadRepository } from '../db/repositories/upload-repository';
import { treesForTask } from '../history/task-owned-trees';

const logger = pino({ level: 'silent' });
const stores: TempStore[] = [];
const servers: Server[] = [];
const harnesses: VerificationHarness[] = [];
const detachSockets: (() => void)[] = [];
const sockets: WebSocket[] = [];
const apps: FullApp[] = [];
const outsides: string[] = [];
/** Tables that belong to the installation, not to any task. */
const GLOBAL_TABLES = [
  '__drizzle_migrations', 'app_meta', 'conversation_event_kind', 'runtime_environment', 'sqlite_sequence',
  'task_template', // FEAT-111: a saved task outlives its source task (D11 ownership decision)
  'template_revision', // FEAT-111: a saved task outlives its source task (D11 ownership decision)
  'template_revision_file', // FEAT-111: a saved task outlives its source task (D11 ownership decision)
];
afterEach(async () => {
  for (const socket of sockets.splice(0)) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  for (const detach of detachSockets.splice(0)) detach();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.dispose();
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const app of apps.splice(0)) await app.close();
  for (const outside of outsides.splice(0)) rmSync(outside, { recursive: true, force: true });
});

/** Every real directory under a root whose name is one of the given ids, skipping the given subtrees. */
function directoriesNamed(root: string, names: ReadonlySet<string>, skip: readonly string[] = []): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || skip.includes(full)) return [];
    return [...(names.has(entry.name) ? [full] : []), ...directoriesNamed(full, names, skip)];
  });
}

function setup() {
  const store = createTempStore('automate-history-e2e-'); stores.push(store);
  const tasks = new TaskRepository(store.connection);
  const executions = new ExecutionRepository(store.connection);
  const history = new HistoryRepository(store.connection);
  const events = new ConversationEventRepository(store.connection);
  const provider = new FakeAgentProvider();
  const registry = new TaskSessionRegistry({
    provider, executions, events, strategy: new PassthroughRunStrategy(), paths: store.paths,
    model: () => ({ provider: 'fake', id: 'fake' }), auth: () => ({ mode: 'managed' }),
    logger, maxConcurrentExecutions: 8,
  });
  return { store, tasks, executions, history, events, provider, registry };
}

async function serve(s: ReturnType<typeof setup>): Promise<string> {
  const config = getServerConfig({});
  const deletion = new TaskDeletionService({ paths: s.store.paths, tasks: s.tasks, executions: s.executions, registry: s.registry, logger });
  const app = createApp({ logger, dataRoot: s.store.root, version: 'test', getSchemaVersion: () => '8', paths: s.store.paths, serverConfig: config, history: { history: s.history, tasks: s.tasks, deletion, config } });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
  config.port = address.port;
  detachSockets.push(attachExecutionSocket(server, { executions: s.executions, events: s.events, registry: s.registry, config, logger }));
  return `http://127.0.0.1:${address.port}`;
}

function socketMessage(socket: WebSocket): Promise<{ events?: { seq: number }[]; lastSeq?: number }> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString()) as never));
    socket.once('error', reject);
  });
}

async function json<T>(url: string, init?: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

type List = { items: { task: { id: number }; latestRun: { id: number; status: string; errorCode: string | null }; runCount: number }[]; nextCursor: string | null; hasMore: boolean };

async function allPages(base: string): Promise<List['items']> {
  const items: List['items'] = []; let cursor: string | null = null;
  do {
    const page: List = (await json<List>(`${base}/api/tasks?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).body;
    items.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return items;
}

describe('history end to end', () => {
  it('distinguishes graceful app closure from a person cancelling', async () => {
    const s = setup();
    let release!: () => void;
    const waitUntil = new Promise<void>((resolve) => { release = resolve; });
    s.provider.enqueue([{ events: [], result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } }, waitUntil }]);
    const created = s.tasks.createWithExecution('Close during run');
    s.registry.start(created.execution, created.task);
    for (let spins = 0; spins < 100 && s.provider.sessions.length === 0; spins++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(s.provider.sessions).toHaveLength(1);
    await s.registry.drain(1_000); release();
    const base = await serve(s);
    const item = (await json<List>(`${base}/api/tasks`)).body.items[0]!;
    expect(item.latestRun).toMatchObject({ status: 'aborted', errorCode: 'EXECUTION_STOPPED_ON_SHUTDOWN' });
    const record = (await json<{ execution: { errorMessage: string } }>(`${base}/api/executions/${created.execution.id}/record`)).body;
    expect(record.execution.errorMessage).toMatch(/app was closed/i);
  });

  it('keeps history live across a socket disconnect and replays the missed sequence on reconnect', async () => {
    const s = setup();
    s.provider.enqueue([{ events: [], result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } }, waitUntil: new Promise<void>(() => undefined) }]);
    const created = s.tasks.createWithExecution('Keep the transcript');
    s.registry.start(created.execution, created.task);
    for (let spins = 0; spins < 100 && s.executions.getById(created.execution.id)?.status !== 'generating'; spins++) await new Promise((resolve) => setTimeout(resolve, 2));
    const base = await serve(s);
    expect((await json<List>(`${base}/api/tasks?status=running`)).body.items[0]?.latestRun.id).toBe(created.execution.id);
    const first = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws/executions/${created.execution.id}`); sockets.push(first);
    const initial = await socketMessage(first);
    const seen = initial.events?.map((event) => event.seq) ?? [];
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, index) => index + 1));
    first.terminate();
    expect((await json<List>(`${base}/api/tasks?status=running`)).body.items[0]?.latestRun.id).toBe(created.execution.id);
    await s.registry.abort(created.execution.id);
    const reconnect = new WebSocket(`${base.replace('http:', 'ws:')}/api/ws/executions/${created.execution.id}?afterSeq=${seen.at(-1) ?? 0}`); sockets.push(reconnect);
    const replay = await socketMessage(reconnect);
    const missed = replay.events?.map((event) => event.seq) ?? [];
    expect(missed).toEqual(Array.from({ length: missed.length }, (_, index) => (seen.at(-1) ?? 0) + index + 1));
    expect((await json<List>(`${base}/api/tasks?status=stopped`)).body.items[0]?.latestRun.id).toBe(created.execution.id);
  });

  it('finds both runs of a rejected and retried task, with outputs and provenance links intact', async () => {
    const writes = (label: string): FakePythonRun => ({
      onRun: (request) => {
        if (!request.env.AUTOMATE_OUTPUT_DIR || !request.args.includes('main.py')) return;
        writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR, 'totals.csv'), `run=${label}\n`);
        writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Report' }] }));
      },
      result: { stdout: 'done', exitCode: 0, outcome: 'passed' },
    });
    const h = await createVerificationHarness({ pythonRuns: [{}, {}, writes('first'), {}, writes('second')], onApproved: () => undefined });
    harnesses.push(h);
    expect((await h.runToGate()).status).toBe('awaiting_approval');
    await h.approve(); await h.scriptRun.run(h.execution.id, new AbortController().signal);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    const rejected = h.review.review(h.execution.id, { verdict: 'rejected', feedback: 'Try another way.' });
    const retryId = rejected.retryExecutionId!;
    await h.settledPhases(retryId);
    expect(h.repos.executions.getById(retryId)?.status).toBe('awaiting_approval');
    await h.approve(retryId); await h.scriptRun.run(retryId, new AbortController().signal);
    expect(h.repos.executions.getById(retryId)?.status).toBe('awaiting_review');
    h.review.review(retryId, { verdict: 'accepted' });
    const artifacts = new ArtifactRepository(h.store.connection);
    const history = new HistoryRepository(h.store.connection);
    const config = getServerConfig({}); const artifactConfig = getArtifactConfig({});
    const artifactService = new ArtifactService({ paths: h.store.paths, artifacts, scriptRuns: h.repos.scriptRuns, executions: h.repos.executions, tasks: h.repos.tasks, config: artifactConfig, maxInflatedBytes: 1 << 30 });
    const deletion = new TaskDeletionService({ paths: h.store.paths, tasks: h.repos.tasks, executions: h.repos.executions, registry: h.registry, logger });
    const app = createApp({ logger, dataRoot: h.store.root, version: 'test', getSchemaVersion: () => '8', paths: h.store.paths, serverConfig: config, history: { history, tasks: h.repos.tasks, deletion, config }, artifacts: { artifacts: artifactService, root: h.store.root, maxTablePageRows: artifactConfig.maxTablePageRows } });
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test address');
    config.port = address.port; const base = `http://127.0.0.1:${address.port}`;
    const page = (await json<List>(`${base}/api/tasks`)).body;
    expect(page.items).toMatchObject([{ task: { id: h.task.id }, latestRun: { id: retryId, status: 'completed' }, runCount: 2 }]);
    const timeline = (await json<{ items: { id: number; trigger: string }[] }>(`${base}/api/tasks/${h.task.id}/runs`)).body;
    expect(timeline.items.map((item) => [item.id, item.trigger])).toEqual([[retryId, 'feedback'], [h.execution.id, 'manual']]);
    for (const [id, label] of [[h.execution.id, 'first'], [retryId, 'second']] as const) {
      const record = (await json<{ chain: { previous: { id: number; runNumber: number } | null; next: { id: number; runNumber: number }[] }; outputs: { count: number } }>(`${base}/api/executions/${id}/record`)).body;
      expect(record.outputs.count).toBe(1);
      expect(record.chain).toEqual(id === h.execution.id ? { previous: null, next: [{ id: retryId, runNumber: 2 }] } : { previous: { id: h.execution.id, runNumber: 1 }, next: [] });
      const listed = (await json<{ artifacts: { id: number; filename: string }[] }>(`${base}/api/executions/${id}/artifacts`)).body;
      expect(listed.artifacts.map((item) => item.filename)).toEqual(['totals.csv']);
      expect(await (await fetch(`${base}/api/artifacts/${listed.artifacts[0]!.id}/download`)).text()).toBe(`run=${label}\n`);
      const archive = readZip(Buffer.from(await (await fetch(`${base}/api/executions/${id}/artifacts/archive`)).arrayBuffer()));
      expect(archive.map((entry) => entry.name)).toEqual(['totals.csv']);
    }
    // Deletion completeness (scenario 5): a question, and a link generated code could leave pointing outside the data root.
    h.repos.clarifications.open({ executionId: h.execution.id, source: 'preflight', status: 'answered', questions: [{ findingKey: 'k', impact: 'meaning', promptText: 'Which?', rationale: 'r', proposedDefault: 'a', answer: 'a', answerSource: 'user' }] });
    const outside = mkdtempSync(path.join(tmpdir(), 'automate-outside-')); outsides.push(outside); writeFileSync(path.join(outside, 'sentinel'), 'keep');
    const outputDir = path.join(h.store.paths.runsDir, String(h.execution.id), 'output'); mkdirSync(outputDir, { recursive: true });
    symlinkSync(outside, path.join(outputDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const response = await fetch(`${base}/api/tasks/${h.task.id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    // Enumerated, not listed by hand: a future task-owned table without a cascade fails here.
    const tables = (h.store.connection.client.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(({ name }) => name).filter((name) => !GLOBAL_TABLES.includes(name));
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const table of tables) expect(h.store.connection.client.prepare(`select count(*) n from ${table}`).get(), table).toMatchObject({ n: 0 });
    for (const tree of treesForTask(h.store.paths, h.task.id, [h.execution.id, retryId])) expect(existsSync(tree.fullPath), tree.kind).toBe(false);
    // uploads/staged/ is skipped: the harness attaches uploads in place, where production renames them into
    // uploads/{taskId}/ (a tree removed above); a staged entry is unattached by definition and FEAT-104's sweep owns it.
    expect(directoriesNamed(h.store.root, new Set([h.task.id, h.execution.id, retryId].map(String)), [h.store.paths.stagedUploadsDir])).toEqual([]);
    expect(readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('reconciles every restart status and serves the phase messages over HTTP', async () => {
    const s = setup(); const ids = new Map<string, number>();
    for (const status of [...INTERRUPTED_ON_RESTART, ...SURVIVES_RESTART]) {
      const created = s.tasks.createWithExecution(`Task in ${status}`);
      s.store.connection.client.prepare('update execution set status = ? where id = ?').run(status, created.execution.id);
      ids.set(status, created.execution.id);
    }
    const before = await allPages(await serve(s));
    const sessions = s.provider.opened.length;
    expect(s.registry.reconcileOnStartup()).toBe(INTERRUPTED_ON_RESTART.length);
    expect(s.provider.opened).toHaveLength(sessions);
    const base = await serve(s);
    const after = await allPages(base);
    expect(after.map((item) => item.task.id)).toEqual(before.map((item) => item.task.id));
    for (const status of INTERRUPTED_ON_RESTART) {
      const id = ids.get(status)!;
      const item = after.find((entry) => entry.latestRun.id === id)!;
      expect(item.latestRun).toMatchObject({ status: 'failed', errorCode: 'EXECUTION_INTERRUPTED' });
      const record = (await json<{ execution: { errorMessage: string } }>(`${base}/api/executions/${id}/record`)).body;
      expect(record.execution.errorMessage).toBe(INTERRUPTION_MESSAGES[status]);
    }
    for (const status of SURVIVES_RESTART) {
      const item = after.find((entry) => entry.latestRun.id === ids.get(status))!;
      expect(item.latestRun.status).toBe(status);
      expect(HISTORY_STATUS_GROUPS.needs_you).toContain(status);
    }
    const needsYou = (await json<List>(`${base}/api/tasks?status=needs_you`)).body;
    expect(needsYou.items.map((item) => item.latestRun.status).sort()).toEqual([...SURVIVES_RESTART].sort());
  });

  it('refuses a second open run, preserving one list row and the original timeline', async () => {
    const s = setup(); const created = s.tasks.createWithExecution('Retry guard');
    s.executions.markSettled(created.execution.id, { status: 'failed' });
    const retry = s.executions.createRetry(created.execution.id, 'try another way');
    s.store.connection.client.prepare("update execution set status = 'awaiting_approval' where id = ?").run(retry.id);
    expect(() => s.executions.createRetry(created.execution.id, 'again')).toThrow(/Finish or cancel it first/i);
    expect(() => s.executions.createFeedbackRetry(created.execution.id, 'wrong')).toThrow(/Finish or cancel it first/i);
    const base = await serve(s);
    const page = (await json<List>(`${base}/api/tasks`)).body;
    expect(page.items).toMatchObject([{ latestRun: { id: retry.id, status: 'awaiting_approval' }, runCount: 2 }]);
    const timeline = (await json<{ items: { id: number; trigger: string }[] }>(`${base}/api/tasks/${created.task.id}/runs`)).body;
    expect(timeline.items.map((item) => [item.id, item.trigger])).toEqual([[retry.id, 'rerun'], [created.execution.id, 'manual']]);
    const refused = await fetch(`${base}/api/tasks/${created.task.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(s.tasks.getById(created.task.id)).toBeDefined();
  });

  it('deletes all owned rows and all five directory trees while preserving another task', async () => {
    const s = setup(); const target = s.tasks.createWithExecution('Delete everything');
    s.executions.markSettled(target.execution.id, { status: 'failed' });
    const secondRun = s.executions.createRetry(target.execution.id, 'retry');
    s.executions.markSettled(secondRun.id, { status: 'failed' });
    const keeper = s.tasks.createWithExecution('Keep me');
    const roots = [
      path.join(s.store.paths.uploadsDir, String(target.task.id)), s.store.paths.taskArtifactsDir(target.task.id),
      ...[target.execution.id, secondRun.id].flatMap((id) => [path.join(s.store.paths.runsDir, String(id)), path.join(s.store.paths.scriptsDir, String(id)), path.join(s.store.paths.agentSessionsDir, String(id))]),
    ];
    for (const root of roots) { mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, 'private.txt'), 'private'); }
    const base = await serve(s);
    const deleted = await json<{ removed: { runs: number }; filesPendingRemoval: number }>(`${base}/api/tasks/${target.task.id}`, { method: 'DELETE' });
    expect(deleted.response.status).toBe(200);
    expect(deleted.body).toMatchObject({ removed: { runs: 2 }, filesPendingRemoval: 0 });
    for (const root of roots) expect(existsSync(root), root).toBe(false);
    expect(s.tasks.getById(target.task.id)).toBeUndefined();
    expect(s.tasks.getById(keeper.task.id)).toBeDefined();
    for (const table of ['conversation_event', 'disclosure_transmission', 'clarification', 'code_version', 'generation_attempt', 'synthetic_fixture', 'verification_run', 'execution_approval', 'script_run', 'artifact']) {
      expect(s.store.connection.client.prepare(`select count(*) n from ${table} where execution_id in (?, ?)`).get(target.execution.id, secondRun.id), table).toMatchObject({ n: 0 });
    }
    const list = (await json<List>(`${base}/api/tasks`)).body;
    expect(list.items.map((item) => item.task.id)).toEqual([keeper.task.id]);
    expect(TASK_OWNED_TREES).toHaveLength(5);
  });

  it('removes every tree\'s residue at startup after rows were deleted and file cleanup never ran', async () => {
    const s = setup(); const created = s.tasks.createWithExecution('Interrupted delete');
    s.executions.markSettled(created.execution.id, { status: 'failed' });
    const trees = treesForTask(s.store.paths, created.task.id, [created.execution.id]);
    for (const tree of trees) { mkdirSync(tree.fullPath, { recursive: true }); writeFileSync(path.join(tree.fullPath, 'copy.csv'), 'private'); }
    s.tasks.deleteOwnedRows(created.task.id); // the crash: rows committed, removeTree never called
    for (const tree of trees) expect(existsSync(tree.fullPath)).toBe(true);
    // The rebuilt server's startup sweeps, in index.ts order: FEAT-104, FEAT-109, then FEAT-110.
    await new StagedUploadSweeper({ uploads: new UploadRepository(s.store.connection), tasks: s.tasks, store: new UploadFileStore(s.store.paths), ttlHours: 24, logger }).sweep();
    await new ArtifactSweeper({ paths: s.store.paths, taskExists: (taskId) => Boolean(s.tasks.getById(taskId)), logger }).sweepOrphanArtifactDirectories();
    const sweeper = new RetentionSweeper({ paths: s.store.paths, history: s.history, consents: new DisclosureConsentRepository(s.store.connection), ttlHours: 24, logger });
    expect(await sweeper.sweep()).toMatchObject({ treesRemoved: 3, treesPending: 0 });
    for (const tree of trees) expect(existsSync(tree.fullPath), tree.kind).toBe(false);
    const base = await serve(s);
    expect((await json<List>(`${base}/api/tasks`)).body.items).toEqual([]);
    sweeper.stop();
  });

  it('keeps both database-backed gates actionable across a restart: an approval then runs, and a review then completes', async () => {
    const output: FakePythonRun = {
      onRun: (request) => {
        if (!request.env.AUTOMATE_OUTPUT_DIR || !request.args.includes('main.py')) return;
        writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR, 'totals.csv'), 'region,total\n');
        writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Report' }] }));
      },
      result: { stdout: 'done', exitCode: 0, outcome: 'passed' },
    };
    const h = await createVerificationHarness({ pythonRuns: [{}, {}, output], onApproved: () => undefined });
    harnesses.push(h);
    const restart = () => new TaskSessionRegistry({ provider: new FakeAgentProvider([], new Error('a restart must not open a session')), executions: h.repos.executions, events: h.repos.events, strategy: new PassthroughRunStrategy(), paths: h.store.paths, model: () => ({ provider: 'fake', id: 'fake' }), auth: () => ({ mode: 'managed' }), logger, maxConcurrentExecutions: 5 }).reconcileOnStartup();
    expect((await h.runToGate()).status).toBe('awaiting_approval');
    const parked = h.repos.executions.getById(h.execution.id);
    expect(restart()).toBe(0);
    expect(h.repos.executions.getById(h.execution.id)).toEqual(parked);
    await h.approve(); await h.scriptRun.run(h.execution.id, new AbortController().signal);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('awaiting_review');
    expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toMatchObject({ status: 'succeeded' });
    expect(restart()).toBe(0);
    h.review.review(h.execution.id, { verdict: 'accepted' });
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('completed');
  });

  it('answers a retry of an older run with 409 over HTTP while the latest run is parked, and creates no row', async () => {
    const full = await startFullApp(); apps.push(full);
    const { h, base } = full;
    h.store.connection.client.prepare("update execution set status = 'failed' where id = ?").run(h.execution.id);
    const latest = h.repos.executions.createRetry(h.execution.id, null);
    h.store.connection.client.prepare("update execution set status = 'awaiting_approval' where id = ?").run(latest.id);
    const response = await fetch(`${base}/api/executions/${h.execution.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TASK_HAS_OPEN_RUN' } });
    expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(2);
  });

});

describe('history boundaries', () => {
  it('lists, records, deletes, and sweeps without opening a provider session', async () => {
    const s = setup();
    const refusing = new FakeAgentProvider([], new Error('history must never open a provider session'));
    const registry = new TaskSessionRegistry({ provider: refusing, executions: s.executions, events: s.events, strategy: new PassthroughRunStrategy(), paths: s.store.paths, model: () => ({ provider: 'fake', id: 'fake' }), auth: () => ({ mode: 'managed' }), logger, maxConcurrentExecutions: 2 });
    const created = s.tasks.createWithExecution('Read me'); s.executions.markSettled(created.execution.id, { status: 'failed' });
    const base = await serve({ ...s, registry });
    expect((await fetch(`${base}/api/tasks`)).status).toBe(200);
    expect((await fetch(`${base}/api/tasks/${created.task.id}/runs`)).status).toBe(200);
    expect((await fetch(`${base}/api/executions/${created.execution.id}/record`)).status).toBe(200);
    expect((await fetch(`${base}/api/tasks/${created.task.id}`, { method: 'DELETE' })).status).toBe(200);
    await new RetentionSweeper({ paths: s.store.paths, history: s.history, consents: new DisclosureConsentRepository(s.store.connection), ttlHours: 24, logger }).sweep();
    expect(refusing.opened).toEqual([]);
  });

  const sourceRoot = path.join(import.meta.dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name); return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') ? [full] : [];
  });
  it('history modules cannot open agent sessions or assemble prompts', () => {
    for (const file of files(path.join(sourceRoot, 'history'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*\/agent(\/|['"])/);
      expect(source, file).not.toMatch(/assemblePromptContext|\.open\(/);
    }
  });
  it('core history contracts do not import Node built-ins', () => {
    for (const file of files(path.join(sourceRoot, '..', '..', 'core', 'src', 'history'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"]node:/);
    }
  });
});
