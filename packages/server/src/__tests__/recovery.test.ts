import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { WebSocket } from 'ws';
import {
  FakeAgentProvider,
  type FakeAgentScript,
} from '../agent/testing/fake-agent-provider';
import { createApp } from '../app';
import {
  ensureAppDirectories,
  getAppPaths,
  type AppPaths,
} from '../config/app-paths';
import type { ServerConfig } from '../config/env';
import {
  PassthroughRunStrategy,
  TaskSessionRegistry,
} from '../conversation/index';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { attachExecutionSocket } from '../ws/index';

let root: string;
let paths: AppPaths;
let connection: DatabaseConnection;
let tasks: TaskRepository;
let executions: ExecutionRepository;
let events: ConversationEventRepository;
const resources: (() => Promise<void> | void)[] = [];
const logger = pino({ level: 'silent' });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-recovery-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
  tasks = new TaskRepository(connection);
  executions = new ExecutionRepository(connection);
  events = new ConversationEventRepository(connection);
});
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
  connection.close();
  rmSync(root, { recursive: true, force: true });
});
function makeRegistry(provider: FakeAgentProvider) {
  return new TaskSessionRegistry({
    provider,
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths,
    model: () => ({ provider: 'fake', id: 'fake' }),
    auth: () => ({ mode: 'managed' }),
    logger,
    maxConcurrentExecutions: 4,
  });
}
async function slowRun() {
  let release!: () => void;
  const waitUntil = new Promise<void>((resolve) => {
    release = resolve;
  });
  const script: FakeAgentScript = {
    events: [],
    result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } },
    waitUntil,
  };
  const provider = new FakeAgentProvider([script]);
  const registry = makeRegistry(provider);
  const task = tasks.create({ name: 'A', description: 'A' });
  const execution = executions.create(task.id);
  const session = registry.start(execution, task);
  await viWait(() => provider.sessions.length === 1);
  return { provider, registry, task, execution, session, release };
}
async function viWait(predicate: () => boolean) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
}
async function socketServer(registry: TaskSessionRegistry) {
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    maxConcurrentExecutions: 4,
    allowedOrigins: [],
    nodeEnv: 'test',
  };
  const app = createApp({
    logger,
    dataRoot: root,
    version: 'test',
    paths,
    getSchemaVersion: () => '2',
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  config.port = address.port;
  const detach = attachExecutionSocket(server, {
    executions,
    events,
    registry,
    config,
    logger,
  });
  resources.push(async () => {
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `ws://127.0.0.1:${address.port}`;
}
function next(socket: WebSocket): Promise<{
  type: string;
  events?: { seq: number }[];
  event?: { seq: number };
}> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as never),
    );
    socket.once('error', reject);
  });
}
function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}
function assertContiguous(executionId: number) {
  const stored = events.listAfter(executionId, 0, 500).events;
  expect(stored.map((event) => event.seq)).toEqual(
    stored.map((_, index) => index + 1),
  );
  return stored;
}

describe('execution recovery outcomes', () => {
  it('replays exactly what was missed during a browser disconnect', async () => {
    const run = await slowRun();
    const base = await socketServer(run.registry);
    const first = new WebSocket(
      `${base}/api/ws/executions/${run.execution.id}`,
    );
    const snapshot = await next(first);
    const seen = snapshot.events ?? [];
    const cursor = seen.at(-1)?.seq ?? 0;
    await closeSocket(first);
    run.provider.sessions[0]?.emit({
      type: 'assistant_text',
      text: 'while away',
      at: new Date().toISOString(),
    });
    run.release();
    await run.session.settled;
    const second = new WebSocket(
      `${base}/api/ws/executions/${run.execution.id}?afterSeq=${cursor}`,
    );
    const replay = await next(second);
    const merged = [...seen, ...(replay.events ?? [])];
    expect(merged).toEqual(assertContiguous(run.execution.id));
    await closeSocket(second);
  });
  it('marks a server-restart survivor interrupted once', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const run = executions.create(task.id);
    executions.markStarted(run.id);
    events.append(run.id, {
      seq: 1,
      type: 'state_changed',
      from: 'pending',
      to: 'generating',
      at: new Date().toISOString(),
    });
    const fresh = makeRegistry(new FakeAgentProvider());
    expect(fresh.reconcileOnStartup()).toBe(1);
    expect(fresh.reconcileOnStartup()).toBe(0);
    expect(executions.getById(run.id)).toMatchObject({
      status: 'failed',
      errorCode: 'EXECUTION_INTERRUPTED',
    });
    expect(assertContiguous(run.id).at(-1)).toMatchObject({
      type: 'state_changed',
      to: 'failed',
    });
  });
  it('graceful drain aborts and settles a live run', async () => {
    const run = await slowRun();
    await run.registry.drain(1_000);
    expect(executions.getById(run.execution.id)?.status).toBe('aborted');
    assertContiguous(run.execution.id);
  });
  it('delivers an abort performed while no socket is attached', async () => {
    const run = await slowRun();
    await run.registry.abort(run.execution.id);
    const base = await socketServer(run.registry);
    const socket = new WebSocket(
      `${base}/api/ws/executions/${run.execution.id}`,
    );
    const snapshot = await next(socket);
    expect(snapshot.events?.at(-1)).toMatchObject({
      type: 'state_changed',
      to: 'aborted',
    });
    assertContiguous(run.execution.id);
    await closeSocket(socket);
  });
  it('fans out identical events to two clients without coupling their lifetimes', async () => {
    const run = await slowRun();
    const base = await socketServer(run.registry);
    const one = new WebSocket(`${base}/api/ws/executions/${run.execution.id}`);
    const two = new WebSocket(`${base}/api/ws/executions/${run.execution.id}`);
    await Promise.all([next(one), next(two)]);
    const firstOne = next(one);
    const firstTwo = next(two);
    run.provider.sessions[0]?.emit({
      type: 'assistant_text',
      text: 'both',
      at: new Date().toISOString(),
    });
    expect((await firstOne).event?.seq).toBe((await firstTwo).event?.seq);
    await closeSocket(one);
    const onlyTwo = next(two);
    run.provider.sessions[0]?.emit({
      type: 'turn_finished',
      usage: { turns: 1 },
      at: new Date().toISOString(),
    });
    expect((await onlyTwo).event?.seq).toBeGreaterThan(0);
    await run.registry.abort(run.execution.id);
    await closeSocket(two);
    assertContiguous(run.execution.id);
  });
});
