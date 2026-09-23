import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositoryError } from '@automate/core';
import { ensureAppDirectories, getAppPaths } from '../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../client';
import { migrateDatabase } from '../migrate';
import { ConversationEventRepository } from './conversation-event-repository';
import { ExecutionRepository } from './execution-repository';
import { TaskRepository, deriveTaskName } from './task-repository';

let root: string;
let connection: DatabaseConnection;
let tasks: TaskRepository;
let executions: ExecutionRepository;
let events: ConversationEventRepository;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-repo-'));
  const paths = getAppPaths(root);
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

describe('conversation repositories', () => {
  it('derives names and preserves prompts verbatim', () => {
    const prompt = '\n  Prepare   this report  \nsecond λ';
    const created = tasks.create({
      name: deriveTaskName(prompt),
      description: prompt,
    });
    expect(tasks.getById(created.id)?.description).toBe(prompt);
    expect(created.name).toBe('Prepare this report');
    expect(deriveTaskName('!')).toBe('Untitled task');
    expect(deriveTaskName('x'.repeat(90))).toHaveLength(80);
  });

  it('enforces state transitions, usage nulls, and active filtering', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const row = executions.create(task.id);
    expect(() =>
      executions.markSettled(row.id, { status: 'completed' }),
    ).toThrow();
    expect(executions.getById(row.id)?.status).toBe('pending');
    executions.markStarted(row.id);
    const settled = executions.markSettled(row.id, { status: 'completed' });
    expect(settled.usageTurns).toBeNull();
    expect(settled.durationMs).toBeGreaterThanOrEqual(0);
    expect(executions.listActive()).toEqual([]);
  });

  it('paginates ordered events and rejects duplicate seq', () => {
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
    expect(events.maxSeq(run.id)).toBe(2);
    expect(events.maxSeq(999)).toBe(0);
    expect(events.listAfter(run.id, 0, 1)).toMatchObject({
      lastSeq: 1,
      hasMore: true,
    });
    expect(events.listAfter(run.id, 2, 1)).toEqual({
      events: [],
      lastSeq: 2,
      hasMore: false,
    });
    expect(() =>
      events.append(run.id, {
        seq: 2,
        type: 'assistant_text',
        text: 'again',
        at: new Date().toISOString(),
      }),
    ).toThrow(RepositoryError);
  });

  it('cascades task deletion through execution events with foreign keys enabled', () => {
    const task = tasks.create({ name: 'A', description: 'A' });
    const run = executions.create(task.id);
    events.append(run.id, {
      seq: 1,
      type: 'user_prompt',
      text: 'A',
      at: new Date().toISOString(),
    });
    connection.client.prepare('DELETE FROM task WHERE id = ?').run(task.id);
    expect(
      connection.client.prepare('SELECT count(*) count FROM execution').get(),
    ).toEqual({ count: 0 });
    expect(
      connection.client
        .prepare('SELECT count(*) count FROM conversation_event')
        .get(),
    ).toEqual({ count: 0 });
    expect(connection.client.prepare('PRAGMA foreign_key_check').all()).toEqual(
      [],
    );
  });
});
