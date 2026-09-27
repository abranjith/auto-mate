import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';
import { TaskRepository } from '../../db/repositories/task-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { TaskDeletionService } from '../../history/task-deletion-service';
import { treesForTask } from '../../history/task-owned-trees';
import type { TaskSessionRegistry } from '../../conversation/task-session-registry';

/** Memory's pass-through pattern: `rm` fails with EBUSY only for a path containing the flagged marker. */
const busy = vi.hoisted(() => ({ marker: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rm: typeof actual.rm = async (target, options) => {
    if (busy.marker && String(target).includes(busy.marker)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    return actual.rm(target, options);
  };
  return { ...actual, default: { ...actual, rm }, rm };
});

const stores: TempStore[] = [];
afterEach(() => { busy.marker = null; stores.splice(0).forEach((store) => store.dispose()); });
function setup() {
  const store = createTempStore('automate-delete-'); stores.push(store);
  const tasks = new TaskRepository(store.connection); const executions = new ExecutionRepository(store.connection);
  const deletion = new TaskDeletionService({ paths: store.paths, tasks, executions, registry: { isLive: () => false } as unknown as TaskSessionRegistry, logger: pino({ level: 'silent' }) });
  return { store, tasks, executions, deletion };
}
function plant(store: TempStore, taskId: number, executionIds: number[], content: string) {
  for (const tree of treesForTask(store.paths, taskId, executionIds)) { mkdirSync(tree.fullPath, { recursive: true }); writeFileSync(path.join(tree.fullPath, 'owned'), content); }
}

describe('whole task deletion', () => {
  it('removes every owned tree and row, preserving another task and an outside link target', async () => {
    const { store, tasks, executions, deletion } = setup();
    const first = tasks.createWithExecution('Delete this task'); const second = tasks.createWithExecution('Keep this task');
    executions.markSettled(first.execution.id, { status: 'failed' });
    plant(store, first.task.id, [first.execution.id], 'remove'); plant(store, second.task.id, [second.execution.id], 'keep');
    const outside = path.join(tmpdir(), `automate-delete-outside-${Date.now()}`); mkdirSync(outside); writeFileSync(path.join(outside, 'sentinel'), 'keep');
    symlinkSync(outside, path.join(store.paths.runsDir, String(first.execution.id), 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(await deletion.delete(first.task.id)).toEqual({ taskId: first.task.id, removed: { runs: 1, inputs: 0, outputs: 0 }, filesPendingRemoval: 0 });
      expect(tasks.getById(first.task.id)).toBeUndefined(); expect(executions.getById(first.execution.id)).toBeUndefined();
      for (const tree of treesForTask(store.paths, first.task.id, [first.execution.id])) expect(existsSync(tree.fullPath)).toBe(false);
      for (const tree of treesForTask(store.paths, second.task.id, [second.execution.id])) expect(existsSync(tree.fullPath)).toBe(true);
      expect(existsSync(path.join(outside, 'sentinel'))).toBe(true);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('reports a locked tree as pending removal while the rows are gone and every other tree is removed', async () => {
    const { store, tasks, executions, deletion } = setup();
    const created = tasks.createWithExecution('A file is open elsewhere');
    executions.markSettled(created.execution.id, { status: 'failed' });
    plant(store, created.task.id, [created.execution.id], 'owned');
    const locked = path.join(store.paths.scriptsDir, String(created.execution.id));
    busy.marker = locked;
    expect(await deletion.delete(created.task.id)).toMatchObject({ removed: { runs: 1 }, filesPendingRemoval: 1 });
    expect(tasks.getById(created.task.id)).toBeUndefined();
    expect(existsSync(locked)).toBe(true);
    for (const tree of treesForTask(store.paths, created.task.id, [created.execution.id]).filter(({ fullPath }) => fullPath !== locked)) expect(existsSync(tree.fullPath), tree.kind).toBe(false);
  });

  it('refuses a live session and deletes nothing, even when its row already reads terminal', async () => {
    const { store, tasks, executions } = setup();
    const created = tasks.createWithExecution('Still live');
    executions.markSettled(created.execution.id, { status: 'failed' });
    plant(store, created.task.id, [created.execution.id], 'owned');
    const live = new TaskDeletionService({ paths: store.paths, tasks, executions, registry: { isLive: () => true } as unknown as TaskSessionRegistry, logger: pino({ level: 'silent' }) });
    await expect(live.delete(created.task.id)).rejects.toMatchObject({ code: 'TASK_HAS_OPEN_RUN' });
    expect(tasks.getById(created.task.id)).toBeDefined();
    for (const tree of treesForTask(store.paths, created.task.id, [created.execution.id])) expect(existsSync(tree.fullPath)).toBe(true);
  });

  it('refuses a parked run and deletes nothing, asserted by rows and files', async () => {
    const { store, tasks, deletion } = setup();
    const created = tasks.createWithExecution('Waiting for go-ahead');
    store.connection.client.prepare("update execution set status = 'awaiting_approval' where id = ?").run(created.execution.id);
    plant(store, created.task.id, [created.execution.id], 'owned');
    await expect(deletion.delete(created.task.id)).rejects.toMatchObject({ code: 'TASK_HAS_OPEN_RUN' });
    expect(store.connection.client.prepare('select count(*) n from execution').get()).toMatchObject({ n: 1 });
    for (const tree of treesForTask(store.paths, created.task.id, [created.execution.id])) expect(existsSync(tree.fullPath)).toBe(true);
  });
});
