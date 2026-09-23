import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionLimitReachedError } from '@automate/core';
import { FakeAgentProvider } from '../../agent/testing/fake-agent-provider';
import {
  ensureAppDirectories,
  getAppPaths,
  type AppPaths,
} from '../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { ConversationEventRepository } from '../../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { createLogger } from '../../logging/logger';
import { PassthroughRunStrategy } from '../../conversation/run-strategy';
import { TaskSessionRegistry } from '../../conversation/task-session-registry';

let root: string;
let paths: AppPaths;
let connection: DatabaseConnection;
let tasks: TaskRepository;
let executions: ExecutionRepository;
let events: ConversationEventRepository;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-registry-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
  tasks = new TaskRepository(connection);
  executions = new ExecutionRepository(connection);
  events = new ConversationEventRepository(connection);
});
afterEach(() => {
  connection.close();
  rmSync(root, { recursive: true, force: true });
});
function registry(cap: number) {
  return new TaskSessionRegistry({
    provider: new FakeAgentProvider(),
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths,
    model: () => ({ provider: 'fake', id: 'fake' }),
    auth: () => ({ mode: 'managed' }),
    logger: createLogger('silent'),
    maxConcurrentExecutions: cap,
  });
}
function row() {
  const task = tasks.create({ name: 'A', description: 'A' });
  return { task, execution: executions.create(task.id) };
}

describe('TaskSessionRegistry', () => {
  it('reads and enforces different configured caps', () => {
    for (const cap of [1, 3]) {
      const r = registry(cap);
      const rows = Array.from({ length: cap + 1 }, row);
      for (const item of rows.slice(0, cap)) r.start(item.execution, item.task);
      expect(() => r.start(rows[cap]!.execution, rows[cap]!.task)).toThrow(
        ExecutionLimitReachedError,
      );
    }
  });

  it('reconciles active rows once with a terminal event', () => {
    const pending = row();
    const generating = row();
    executions.markStarted(generating.execution.id);
    const complete = row();
    executions.markStarted(complete.execution.id);
    executions.markSettled(complete.execution.id, { status: 'completed' });
    const r = registry(1);
    expect(r.reconcileOnStartup()).toBe(2);
    expect(r.reconcileOnStartup()).toBe(0);
    for (const id of [pending.execution.id, generating.execution.id]) {
      expect(executions.getById(id)).toMatchObject({
        status: 'failed',
        errorCode: 'EXECUTION_INTERRUPTED',
      });
      expect(events.listAfter(id, 0, 10).events.at(-1)).toMatchObject({
        type: 'state_changed',
        to: 'failed',
      });
    }
    expect(executions.getById(complete.execution.id)?.status).toBe('completed');
  });
});
