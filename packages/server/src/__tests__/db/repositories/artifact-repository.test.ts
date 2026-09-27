import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES, CONVERSATION_EVENT_KINDS, RepositoryError } from '@automate/core';
import type { DatabaseConnection } from '../../../db/client';
import { ArtifactRepository } from '../../../db/repositories/artifact-repository';
import { artifactRow, createRunFixture, type RunFixture } from '../../support/artifact-fixtures';

const fixtures: RunFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.store.dispose()));

function setup(): RunFixture {
  const fixture = createRunFixture();
  fixtures.push(fixture);
  return fixture;
}
const count = (c: DatabaseConnection, table: string) => (c.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const insertEvent = (c: DatabaseConnection, executionId: number, seq: number, kind: string) => c.client.prepare('INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (?, ?, ?, ?, ?)').run(executionId, seq, kind, '{}', '2026-09-25T00:00:00Z');

describe('ArtifactRepository', () => {
  it('round-trips a row with a unicode filename, a 64-character digest, and no content scan', () => {
    const f = setup();
    const [id] = f.artifacts.allocateIds(1);
    const [row] = f.artifacts.insertMany([artifactRow(f, id!, { filename: 'résumé 日本.csv', sha256: 'b'.repeat(64), contentScan: null })]);
    expect(f.artifacts.getById(id!)).toEqual(row);
    expect(row).toMatchObject({ filename: 'résumé 日本.csv', sha256: 'b'.repeat(64), contentScan: null, declared: true });
    expect(row!.registeredAt).toBeInstanceOf(Date);
  });

  it('allocates consecutive ids above every id ever issued, even after rows are gone', () => {
    const f = setup();
    expect(f.artifacts.allocateIds(3)).toEqual([1, 2, 3]);
    f.artifacts.insertMany([artifactRow(f, 1), artifactRow(f, 2)]);
    expect(f.artifacts.allocateIds(2)).toEqual([3, 4]);
    f.store.connection.client.exec('DELETE FROM artifact');
    expect(f.artifacts.allocateIds(1)).toEqual([3]);
    expect(f.artifacts.allocateIds(0)).toEqual([]);
  });

  it('writes five rows atomically and rolls back entirely when the fourth violates a constraint', () => {
    const f = setup();
    const ids = f.artifacts.allocateIds(5);
    const rows = ids.map((id) => artifactRow(f, id));
    rows[3] = artifactRow(f, ids[3]!, { byteSize: -1 });
    expect(() => f.artifacts.insertMany(rows)).toThrow(RepositoryError);
    expect(count(f.store.connection, 'artifact')).toBe(0);
    f.artifacts.insertMany(ids.map((id) => artifactRow(f, id)));
    expect(count(f.store.connection, 'artifact')).toBe(5);
  });

  it('refuses a second row for the same filename in the same run rather than overwriting', () => {
    const f = setup();
    const [a, b] = f.artifacts.allocateIds(2);
    f.artifacts.insertMany([artifactRow(f, a!, { filename: 'report.csv' })]);
    expect(() => f.artifacts.insertMany([artifactRow(f, b!, { filename: 'report.csv' })])).toThrow(RepositoryError);
    expect(f.artifacts.listByRun(f.run.id)).toHaveLength(1);
  });

  it('refuses a type or render mode outside the policy, at the schema', () => {
    const f = setup();
    const [a, b] = f.artifacts.allocateIds(2);
    expect(() => f.artifacts.insertMany([artifactRow(f, a!, { type: 'plotly-json' })])).toThrow(RepositoryError);
    expect(() => f.artifacts.insertMany([artifactRow(f, b!, { renderMode: 'iframe' })])).toThrow(RepositoryError);
  });

  it('lists a run declared-first, each group in id order, and counts by task', () => {
    const f = setup();
    const ids = f.artifacts.allocateIds(4);
    f.artifacts.insertMany([artifactRow(f, ids[0]!, { declared: false }), artifactRow(f, ids[1]!), artifactRow(f, ids[2]!, { declared: false }), artifactRow(f, ids[3]!)]);
    expect(f.artifacts.listByExecution(f.executionId).map((row) => row.id)).toEqual([ids[1], ids[3], ids[0], ids[2]]);
    expect(f.artifacts.listByRun(f.run.id).map((row) => row.id)).toEqual([ids[1], ids[3], ids[0], ids[2]]);
    expect(f.artifacts.listByTask(f.taskId).map((row) => row.id)).toEqual(ids);
    expect(f.artifacts.countByTask(f.taskId)).toBe(4);
    expect(f.artifacts.countByTask(999)).toBe(0);
    expect(f.artifacts.listByExecution(999)).toEqual([]);
  });

  it.each([
    ['task', 'DELETE FROM task'],
    ['execution', 'DELETE FROM execution'],
    ['script_run', 'DELETE FROM script_run'],
  ])('cascades from %s, which also proves foreign keys are on', (_parent, statement) => {
    const f = setup();
    f.artifacts.insertMany(f.artifacts.allocateIds(2).map((id) => artifactRow(f, id)));
    expect(count(f.store.connection, 'artifact')).toBe(2);
    f.store.connection.client.exec(statement);
    expect(count(f.store.connection, 'artifact')).toBe(0);
  });

  it('has no method that deletes a single artifact', () => {
    const methods = Object.getOwnPropertyNames(ArtifactRepository.prototype);
    expect(methods.filter((name) => /delete|remove|purge|save/i.test(name))).toEqual([]);
  });
});

describe('ScriptRunRepository.settle counters', () => {
  it('stores artifact and unregistered counts, NULL until registration writes them', () => {
    const f = setup();
    expect(f.scriptRuns.getById(f.run.id)).toMatchObject({ artifactCount: null, unregisteredOutputCount: null });
    const settled = f.scriptRuns.settle(f.run.id, { status: 'succeeded', exitCode: 0, stdout: '', stderr: '', outputTruncated: false, manifestPresent: true, manifestJson: '{"artifacts":[]}', declaredOutputCount: 0, producedOutputCount: 2, durationMs: 5, artifactCount: 1, unregisteredOutputCount: 1 });
    expect(settled).toMatchObject({ artifactCount: 1, unregisteredOutputCount: 1 });
  });
});

describe('TaskRepository.deleteOwnedRows', () => {
  it('refuses an open run, then deletes the row and its cascade and reports what went, touching no file', () => {
    const f = createRunFixture();
    fixtures.push(f);
    f.artifacts.insertMany(f.artifacts.allocateIds(1).map((id) => artifactRow(f, id)));
    expect(() => f.tasks.deleteOwnedRows(f.taskId)).toThrow(expect.objectContaining({ code: 'TASK_HAS_OPEN_RUN' }));
    expect(count(f.store.connection, 'artifact')).toBe(1);
    f.store.connection.client.prepare("update execution set status = 'completed' where id = ?").run(f.executionId);
    expect(f.tasks.deleteOwnedRows(f.taskId)).toEqual({ executionIds: [f.executionId], counts: { runs: 1, inputs: 0, outputs: 1 } });
    for (const table of ['task', 'execution', 'script_run', 'artifact', 'conversation_event']) expect(count(f.store.connection, table)).toBe(0);
    expect(() => f.tasks.deleteOwnedRows(f.taskId)).toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
  });
});

describe('conversation_event_kind', () => {
  it('holds exactly the nineteen kinds, and every one inserts', () => {
    const f = setup();
    const rows = f.store.connection.client.prepare('SELECT kind, owner, added_in AS addedIn FROM conversation_event_kind ORDER BY rowid').all();
    expect(rows).toEqual(CONVERSATION_EVENT_KINDS.map((row) => ({ ...row })));
    expect(rows).toHaveLength(21);
    CONVERSATION_EVENT_KINDS.forEach((row, index) => insertEvent(f.store.connection, f.executionId, index + 1, row.kind));
    expect(count(f.store.connection, 'conversation_event')).toBe(21);
  });

  it('rejects an unknown kind by the foreign key', () => {
    const f = setup();
    expect(() => insertEvent(f.store.connection, f.executionId, 1, 'nonsense')).toThrow(/FOREIGN KEY/i);
  });

  it('refuses to delete a kind that events reference', () => {
    const f = setup();
    insertEvent(f.store.connection, f.executionId, 1, 'user_prompt');
    expect(() => f.store.connection.client.exec("DELETE FROM conversation_event_kind WHERE kind = 'user_prompt'")).toThrow(/FOREIGN KEY/i);
  });

  it('marks exactly FEAT-102\'s five AgentEvent members as agent-owned', () => {
    const f = setup();
    const agent = (f.store.connection.client.prepare("SELECT kind FROM conversation_event_kind WHERE owner = 'agent' ORDER BY kind").all() as { kind: string }[]).map(({ kind }) => kind);
    expect(agent).toEqual([...AGENT_EVENT_TYPES].sort());
  });

  it('has no CHECK on conversation_event.kind any more', () => {
    const f = setup();
    const ddl = (f.store.connection.client.prepare("SELECT sql FROM sqlite_master WHERE name = 'conversation_event'").get() as { sql: string }).sql;
    expect(ddl).not.toMatch(/kind" in \(/i);
    expect(ddl).toMatch(/REFERENCES `conversation_event_kind`\(`kind`\)/);
  });
});
