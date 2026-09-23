import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import pino from 'pino';
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

let root: string;
let paths: AppPaths;
let connection: DatabaseConnection;
let server: Server;
let base: string;
const config: ServerConfig = {
  host: '127.0.0.1',
  port: 4317,
  logLevel: 'silent',
  maxConcurrentExecutions: 1,
  allowedOrigins: [],
  nodeEnv: 'test',
};
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-route-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
  const tasks = new TaskRepository(connection);
  const executions = new ExecutionRepository(connection);
  const events = new ConversationEventRepository(connection);
  const registry = new TaskSessionRegistry({
    provider: new FakeAgentProvider(),
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths,
    model: () => ({ provider: 'fake', id: 'fake' }),
    auth: () => ({ mode: 'managed' }),
    logger: pino({ level: 'silent' }),
    maxConcurrentExecutions: 1,
  });
  const app = createApp({
    logger: pino({ level: 'silent' }),
    dataRoot: root,
    version: 'test',
    paths,
    getSchemaVersion: () => '2',
    conversation: { tasks, executions, events, registry },
    serverConfig: config,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  config.port = address.port;
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  connection.close();
  rmSync(root, { recursive: true, force: true });
});
const headers = { 'content-type': 'application/json' };

describe('task REST surface', () => {
  it('creates a task immediately and replays its transcript', async () => {
    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: '  say hello\nverbatim  ' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      task: { id: number; description: string };
      execution: { id: number };
    };
    expect(body.task.description).toBe('  say hello\nverbatim  ');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = await fetch(
      `${base}/api/executions/${body.execution.id}/events`,
      { headers },
    );
    const page = (await events.json()) as {
      events: { seq: number; type: string }[];
    };
    expect(page.events[0]).toMatchObject({ seq: 1, type: 'state_changed' });
    expect(page.events.map((event) => event.seq)).toEqual(
      page.events.map((_, index) => index + 1),
    );
  });
  it('validates input and wraps missing ids', async () => {
    const invalid = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(invalid.status).toBe(400);
    const missing = await fetch(`${base}/api/executions/999`, { headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: 'EXECUTION_NOT_FOUND' },
    });
  });
  it('rejects a foreign origin before writing', async () => {
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://evil.example' },
      body: JSON.stringify({ prompt: 'no' }),
    });
    expect(response.status).toBe(403);
    expect(
      connection.client.prepare('SELECT count(*) count FROM task').get(),
    ).toEqual({ count: 0 });
  });
});
