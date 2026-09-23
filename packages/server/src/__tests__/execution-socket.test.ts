import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import pino from 'pino';
import { WebSocket } from 'ws';
import { FakeAgentProvider } from '../agent/testing/fake-agent-provider';
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
let server: Server;
let wsBase: string;
let detach: () => void;
let tasks: TaskRepository;
let executions: ExecutionRepository;
let events: ConversationEventRepository;
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 4317,
  logLevel: 'silent',
  maxConcurrentExecutions: 1,
  allowedOrigins: [],
  nodeEnv: 'test',
};
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-ws-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
  tasks = new TaskRepository(connection);
  executions = new ExecutionRepository(connection);
  events = new ConversationEventRepository(connection);
  const logger = pino({ level: 'silent' });
  const registry = new TaskSessionRegistry({
    provider: new FakeAgentProvider(),
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths,
    model: () => ({ provider: 'fake', id: 'fake' }),
    auth: () => ({ mode: 'managed' }),
    logger,
    maxConcurrentExecutions: 1,
  });
  const app = createApp({
    logger,
    dataRoot: root,
    version: 'test',
    paths,
    getSchemaVersion: () => '2',
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  config.port = address.port;
  wsBase = `ws://127.0.0.1:${address.port}`;
  detach = attachExecutionSocket(server, {
    executions,
    events,
    registry,
    config,
    logger,
    heartbeatMs: 50,
  });
});
afterEach(async () => {
  detach();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  connection.close();
  rmSync(root, { recursive: true, force: true });
});
function message(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    socket.once('error', reject);
  });
}

describe('execution socket', () => {
  it('sends only the requested replay window', async () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const run = executions.create(task.id);
    events.append(run.id, {
      seq: 1,
      type: 'user_prompt',
      text: 'A',
      at: new Date().toISOString(),
    });
    events.append(run.id, {
      seq: 2,
      type: 'assistant_text',
      text: 'B',
      at: new Date().toISOString(),
    });
    const socket = new WebSocket(
      `${wsBase}/api/ws/executions/${run.id}?afterSeq=1`,
    );
    const snapshot = await message(socket);
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      lastSeq: 2,
      events: [{ seq: 2 }],
    });
    socket.close();
  });
  it('closes unknown executions with 4004', async () => {
    const socket = new WebSocket(`${wsBase}/api/ws/executions/999`);
    const code = await new Promise<number>((resolve) =>
      socket.once('close', resolve),
    );
    expect(code).toBe(4004);
  });
  it('refuses a foreign origin before the handshake', async () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const run = executions.create(task.id);
    const socket = new WebSocket(`${wsBase}/api/ws/executions/${run.id}`, {
      origin: 'http://evil.example',
    });
    socket.on('error', () => undefined);
    const status = await new Promise<number>((resolve) =>
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }),
    );
    expect(status).toBe(403);
  });
});
