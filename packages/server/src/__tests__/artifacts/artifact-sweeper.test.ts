import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { ArtifactSweeper } from '../../artifacts/artifact-sweeper';
import { ArtifactRegistrar } from '../../artifacts/artifact-registrar';
import { ArtifactRepository } from '../../db/repositories/artifact-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { TaskDeletionService } from '../../history/task-deletion-service';
import type { TaskSessionRegistry } from '../../conversation/task-session-registry';
import { createRunFixture, writeOutput, type RunFixture } from '../support/artifact-fixtures';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

const logger = pino({ level: 'silent' });

/** A registered run, and whole-task deletion wired as production wires it (FEAT-110: rows first, then files). */
async function registeredRun(): Promise<{ fixture: RunFixture; sweeper: ArtifactSweeper; deletion: TaskDeletionService }> {
  const store = createTempStore('automate-sweep-');
  stores.push(store);
  const fixture = createRunFixture({ store });
  const sweeper = new ArtifactSweeper({ paths: store.paths, taskExists: (taskId) => Boolean(fixture.tasks.getById(taskId)), logger });
  for (const name of ['a.csv', 'b.txt', 'c.png']) writeOutput(fixture, name, name);
  await new ArtifactRegistrar({ paths: store.paths, artifacts: fixture.artifacts, logger, maxArtifactsPerRun: 200, scan: { formulaScanRows: 10, maxInflatedBytes: 1 << 30 } }).registerRunOutputs({ scriptRunId: fixture.run.id, executionId: fixture.executionId, taskId: fixture.taskId, outputDir: fixture.outputDir, manifestJson: null }, new AbortController().signal);
  // The fixture leaves its run executing; deletion refuses an open run, so settle it first.
  store.connection.client.prepare("update execution set status = 'completed' where id = ?").run(fixture.executionId);
  const deletion = new TaskDeletionService({ paths: store.paths, tasks: fixture.tasks, executions: fixture.executions, registry: { isLive: () => false } as unknown as TaskSessionRegistry, logger });
  return { fixture, sweeper, deletion };
}

describe('deleting a task (D12: life of the task)', () => {
  it('removes its artifact rows by cascade AND its files and directory, checked on disk', async () => {
    const { fixture, deletion } = await registeredRun();
    const directory = fixture.store.paths.taskArtifactsDir(fixture.taskId);
    expect(readdirSync(directory)).toHaveLength(3);
    expect(await deletion.delete(fixture.taskId)).toMatchObject({ removed: { outputs: 3 }, filesPendingRemoval: 0 });
    expect(new ArtifactRepository(fixture.store.connection).listByTask(fixture.taskId)).toEqual([]);
    expect(existsSync(directory)).toBe(false);
  });

  it('does not throw when a file was already deleted behind the application', async () => {
    const { fixture, sweeper } = await registeredRun();
    const directory = fixture.store.paths.taskArtifactsDir(fixture.taskId);
    rmSync(path.join(directory, readdirSync(directory)[0]!));
    await expect(sweeper.deleteTaskArtifacts(fixture.taskId)).resolves.toBe(2);
    await expect(sweeper.deleteTaskArtifacts(fixture.taskId)).resolves.toBe(0);
  });

  it('leaves other tasks\' artifacts alone', async () => {
    const first = await registeredRun();
    const secondTask = new TaskRepository(first.fixture.store.connection).createWithExecution('Another').task.id;
    const other = first.fixture.store.paths.taskArtifactsDir(secondTask);
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, '9.csv'), 'keep');
    await first.deletion.delete(first.fixture.taskId);
    expect(readFileSync(path.join(other, '9.csv'), 'utf8')).toBe('keep');
  });
});

describe('the orphan sweep', () => {
  it('removes a directory with no task row and never touches a live task\'s, however old', async () => {
    const { fixture, sweeper } = await registeredRun();
    const live = fixture.store.paths.taskArtifactsDir(fixture.taskId);
    const ancient = new Date('2000-01-01T00:00:00Z');
    for (const name of readdirSync(live)) utimesSync(path.join(live, name), ancient, ancient);
    utimesSync(live, ancient, ancient);
    const orphan = path.join(fixture.store.paths.artifactsDir, '999');
    mkdirSync(orphan);
    writeFileSync(path.join(orphan, '1.csv'), 'residue');
    expect(await sweeper.sweepOrphanArtifactDirectories()).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(live)).toHaveLength(3);
  });

  it('is idempotent across two runs', async () => {
    const { fixture, sweeper } = await registeredRun();
    mkdirSync(path.join(fixture.store.paths.artifactsDir, '42'));
    expect(await sweeper.sweepOrphanArtifactDirectories()).toBe(1);
    expect(await sweeper.sweepOrphanArtifactDirectories()).toBe(0);
  });

  it('leaves a directory whose name is not a task id alone rather than guessing', async () => {
    const { fixture, sweeper } = await registeredRun();
    for (const name of ['notes', '007', '-1', '1e3']) mkdirSync(path.join(fixture.store.paths.artifactsDir, name));
    writeFileSync(path.join(fixture.store.paths.artifactsDir, '123'), 'a file, not a directory');
    expect(await sweeper.sweepOrphanArtifactDirectories()).toBe(0);
    expect(readdirSync(fixture.store.paths.artifactsDir).sort()).toEqual(['-1', '007', '123', '1e3', String(fixture.taskId), 'notes'].sort());
  });

  it('copes with a missing artifacts directory', async () => {
    const store = createTempStore('automate-sweep-empty-');
    stores.push(store);
    rmSync(store.paths.artifactsDir, { recursive: true });
    await expect(new ArtifactSweeper({ paths: store.paths, taskExists: () => false, logger }).sweepOrphanArtifactDirectories()).resolves.toBe(0);
  });
});

describe('deferred scope stays deferred', () => {
  it('offers no way to delete one artifact: no sweeper method, no repository method', () => {
    expect(Object.getOwnPropertyNames(ArtifactSweeper.prototype).filter((name) => name !== 'constructor').sort()).toEqual(['deleteTaskArtifacts', 'sweepOrphanArtifactDirectories']);
    expect(Object.getOwnPropertyNames(ArtifactRepository.prototype).filter((name) => /delete|remove|purge/i.test(name))).toEqual([]);
  });

  it('has no route that deletes an individual artifact', () => {
    const route = readFileSync(path.join(import.meta.dirname, '..', '..', 'routes', 'artifact-route.ts'), 'utf8');
    expect(route).not.toMatch(/router\.(delete|post|put|patch)\(/);
    const all = readdirSync(path.join(import.meta.dirname, '..', '..', 'routes')).map((name) => readFileSync(path.join(import.meta.dirname, '..', '..', 'routes', name), 'utf8')).join('\n');
    expect(all).not.toMatch(/\.delete\(\s*['"]\/api\/artifacts/);
  });
});
