import { afterEach, describe, expect, it } from 'vitest';
import { computeVersionDigest, sha256Hex, type InputContract } from '@automate/core';
import { TemplateRepository, type RevisionInput } from '../../../db/repositories/template-repository';
import { ExecutionReuseRepository } from '../../../db/repositories/execution-reuse-repository';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { ExecutionRepository } from '../../../db/repositories/execution-repository';
import { createTempStore, type TempStore } from '../../support/ingestion-fixtures';

const stores: TempStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });

const CONTRACT: InputContract = { version: 1, inputs: [], rules: [], notes: [] };
const FILES = [{ path: 'main.py', role: 'script' as const, content: 'print(1)\n' }, { path: 'test_main.py', role: 'test' as const, content: 'def test_x():\n    pass\n' }, { path: 'helpers.py', role: 'support' as const, content: 'X = 1\n' }];
const DIGEST = computeVersionDigest(FILES.map((file) => ({ path: file.path, sha256: sha256Hex(file.content) })));

function setup() {
  const store = createTempStore('automate-template-repo-'); stores.push(store);
  const tasks = new TaskRepository(store.connection);
  const templates = new TemplateRepository(store.connection);
  const reuse = new ExecutionReuseRepository(store.connection);
  /** A task with one execution whose accepted code becomes a revision. */
  const source = (name = 'Source') => tasks.createWithExecution(name).execution.id;
  const input = (sourceExecutionId: number, overrides: Partial<RevisionInput> = {}): RevisionInput => ({ sourceExecutionId, contentDigest: DIGEST, entrypoint: 'main.py', summary: 'Totals.', declaredInputs: [], declaredOutputs: [], inputContract: CONTRACT, runtimeFingerprint: 'f'.repeat(64), runtimeDetail: { pythonVersion: '3.14.6' }, readsWallClock: false, files: FILES, ...overrides });
  const create = (name = 'Monthly') => { const revisionInput = input(source()); return store.connection.db.transaction((tx) => templates.createWithFirstRevision(tx, { name, description: 'Sum sales.' }, revisionInput)); };
  const count = (table: string) => (store.connection.client.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
  return { store, tasks, templates, reuse, source, input, create, count };
}

describe('TemplateRepository: round trips and numbering', () => {
  it('stores a template with one revision and three files, byte for byte', () => {
    const f = setup();
    const { template, revision } = f.create();
    expect(f.templates.getById(template.id)).toMatchObject({ name: 'Monthly', description: 'Sum sales.' });
    expect(f.templates.getCurrentRevision(template.id)).toEqual(revision);
    expect(f.templates.listFiles(revision.id).map(({ path, role, content, sha256, byteSize }) => ({ path, role, content, sha256, byteSize }))).toEqual(
      [...FILES].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ ...file, sha256: sha256Hex(file.content), byteSize: Buffer.byteLength(file.content) })));
  });

  it('appends 2 then 3, and the current revision is the highest', () => {
    const f = setup();
    const { template } = f.create();
    const numbers = [2, 3].map(() => { const next = f.input(f.source()); return f.store.connection.db.transaction((tx) => f.templates.appendRevision(tx, template.id, next)).revisionNumber; });
    expect(numbers).toEqual([2, 3]);
    expect(f.templates.getCurrentRevision(template.id)!.revisionNumber).toBe(3);
    expect(f.templates.listRevisions(template.id).map((row) => row.revisionNumber)).toEqual([3, 2, 1]);
  });

  it('backs the MAX + 1 read with a unique index, so a racing duplicate number cannot be stored', () => {
    const f = setup();
    const { template, revision } = f.create();
    // Node's SQLite is synchronous, so two promotions cannot interleave through the repository;
    // the index is what a second writer on the same file would hit.
    const duplicate = () => f.store.connection.client.prepare('insert into template_revision (template_id, revision_number, content_digest, entrypoint, summary, declared_inputs, declared_outputs, input_contract, contract_digest, runtime_fingerprint, runtime_detail, reads_wall_clock) select template_id, revision_number, content_digest, entrypoint, summary, declared_inputs, declared_outputs, input_contract, contract_digest, runtime_fingerprint, runtime_detail, reads_wall_clock from template_revision where id = ?').run(revision.id);
    expect(duplicate).toThrow(/UNIQUE/);
    expect(f.templates.listRevisions(template.id)).toHaveLength(1);
  });

  it('allows one revision per source run', () => {
    const f = setup();
    const executionId = f.source();
    const { template } = f.store.connection.db.transaction((tx) => f.templates.createWithFirstRevision(tx, { name: 'A', description: 'd' }, f.input(executionId)));
    expect(() => f.store.connection.db.transaction((tx) => f.templates.appendRevision(tx, template.id, f.input(executionId)))).toThrow(expect.objectContaining({ code: 'REPOSITORY_ERROR' }));
    expect(f.count('template_revision')).toBe(1);
  });

  it('refuses files whose digest does not match, writing nothing', () => {
    const f = setup();
    const tampered = f.input(f.source(), { contentDigest: '0'.repeat(64) });
    expect(() => f.store.connection.db.transaction((tx) => f.templates.createWithFirstRevision(tx, { name: 'A', description: 'd' }, tampered))).toThrow(expect.objectContaining({ code: 'REVISION_INTEGRITY' }));
    expect([f.count('task_template'), f.count('template_revision'), f.count('template_revision_file')]).toEqual([0, 0, 0]);
  });
});

describe('TemplateRepository: immutability', () => {
  it('rejects edits to a revision and its files but lets the source task be deleted', () => {
    const f = setup();
    const { template, revision } = f.create();
    const client = f.store.connection.client;
    expect(() => client.prepare("update template_revision set summary = 'x' where id = ?").run(revision.id)).toThrow('template revisions are immutable');
    const other = f.source('Other');
    expect(() => client.prepare('update template_revision set source_execution_id = ? where id = ?').run(other, revision.id)).toThrow(/immutable/);
    expect(() => client.prepare("update template_revision_file set content = 'x' where revision_id = ?").run(revision.id)).toThrow(/immutable/);
    const sourceTask = f.store.connection.client.prepare('select task_id id from execution where id = ?').get(revision.sourceExecutionId) as { id: number };
    new ExecutionRepository(f.store.connection).markSettled(revision.sourceExecutionId!, { status: 'failed' });
    f.tasks.deleteOwnedRows(sourceTask.id);
    expect(f.templates.getRevision(revision.id)).toEqual({ ...revision, sourceExecutionId: null });
    expect(f.templates.getById(template.id)).toBeDefined();
  });
});

describe('TemplateRepository: deletion and cascades', () => {
  it('deleting a template removes its revisions and files and keeps its runs with their snapshots', () => {
    const f = setup();
    const { template, revision } = f.create();
    const run = f.tasks.createWithExecution('Run of saved');
    f.store.connection.db.transaction((tx) => f.reuse.record(tx, { executionId: run.execution.id, kind: 'run', templateId: template.id, templateRevisionId: revision.id, templateName: 'Monthly', revisionNumber: 1, revisionDigest: DIGEST, compatibilityReport: null, compatibilityDigest: null, mapping: null }));
    expect(f.reuse.countTasksOfTemplate(template.id)).toBe(1);
    expect(f.templates.delete(template.id)).toEqual({ revisions: 1 });
    expect([f.count('task_template'), f.count('template_revision'), f.count('template_revision_file')]).toEqual([0, 0, 0]);
    expect(f.reuse.getByExecution(run.execution.id)).toMatchObject({ templateId: null, templateRevisionId: null, templateName: 'Monthly', revisionNumber: 1, revisionDigest: DIGEST });
    expect(() => f.templates.delete(template.id)).toThrow(expect.objectContaining({ code: 'TEMPLATE_NOT_FOUND' }));
  });

  it('deleting a task removes its reuse rows and bindings by cascade', () => {
    const f = setup();
    const { template, revision } = f.create();
    const run = f.tasks.createWithExecution('Run of saved');
    const uploadId = (f.store.connection.client.prepare("insert into upload (task_id, original_filename, stored_filename, file_path, format, mime_type, byte_size, sha256) values (?, 'a.csv', '1-a.csv', 'uploads/1/1-a.csv', 'csv', 'text/csv', 1, ?) returning id").get(run.task.id, 'a'.repeat(64)) as { id: number }).id;
    f.store.connection.db.transaction((tx) => {
      f.reuse.record(tx, { executionId: run.execution.id, kind: 'run', templateId: template.id, templateRevisionId: revision.id, templateName: 'Monthly', revisionNumber: 1, revisionDigest: DIGEST, compatibilityReport: null, compatibilityDigest: null, mapping: null });
      f.reuse.bind(tx, { executionId: run.execution.id, uploadId, position: 0, inputName: '12-sales.csv' });
    });
    new ExecutionRepository(f.store.connection).markSettled(run.execution.id, { status: 'failed' });
    f.tasks.deleteOwnedRows(run.task.id);
    expect([f.count('execution_reuse'), f.count('execution_input_binding'), f.count('template_revision')]).toEqual([0, 0, 1]);
  });
});

describe('ExecutionReuseRepository: validation', () => {
  it('rejects unsafe input names before the insert, and duplicate slots at the index', () => {
    const f = setup();
    const run = f.tasks.createWithExecution('Run');
    const upload = (name: string) => (f.store.connection.client.prepare("insert into upload (task_id, original_filename, stored_filename, file_path, format, mime_type, byte_size, sha256) values (?, 'a.csv', ?, 'uploads/x', 'csv', 'text/csv', 1, ?) returning id").get(run.task.id, name, 'a'.repeat(64)) as { id: number }).id;
    const [a, b] = [upload('1-a.csv'), upload('2-b.csv')];
    const bind = (uploadId: number, position: number, inputName: string) => f.store.connection.db.transaction((tx) => f.reuse.bind(tx, { executionId: run.execution.id, uploadId, position, inputName }));
    for (const name of ['../x', 'a/b', 'C:\\x', 'CON', 'con.csv', 'NUL', '', '..']) expect(() => bind(a, 0, name), name).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(f.count('execution_input_binding')).toBe(0);
    bind(a, 0, '12-sales.csv');
    expect(() => bind(b, 1, '12-sales.csv')).toThrow(expect.objectContaining({ code: 'REPOSITORY_ERROR' }));
    expect(() => bind(a, 1, '13-other.csv')).toThrow(expect.objectContaining({ code: 'REPOSITORY_ERROR' }));
    expect(() => bind(b, 0, '13-other.csv')).toThrow(expect.objectContaining({ code: 'REPOSITORY_ERROR' }));
    expect(f.reuse.listBindings(run.execution.id)).toHaveLength(1);
  });

  it('rejects a mapping on a saved-code run and a report without its digest', () => {
    const f = setup();
    const run = f.tasks.createWithExecution('Run');
    const record = (overrides: object) => f.store.connection.db.transaction((tx) => f.reuse.record(tx, { executionId: run.execution.id, kind: 'run', templateId: null, templateRevisionId: null, templateName: 'M', revisionNumber: 1, revisionDigest: DIGEST, compatibilityReport: null, compatibilityDigest: null, mapping: null, ...overrides }));
    expect(() => record({ mapping: { columns: [], sheets: [], decisions: [], note: 'x' } })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => record({ compatibilityDigest: 'a'.repeat(64) })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => record({ kind: 'rerun' })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(f.count('execution_reuse')).toBe(0);
  });
});

describe('TemplateRepository.list: keyset pages at a fixed query cost', () => {
  it('pages 45 templates as 20/20/5 with no duplicate or omission, in at most four queries per page', () => {
    const f = setup();
    for (let index = 0; index < 45; index += 1) f.create(`Saved ${index}`);
    const client = f.store.connection.client;
    const prepare = client.prepare.bind(client);
    let queries = 0;
    (client as { prepare: typeof client.prepare }).prepare = ((sql: string) => { queries += 1; return prepare(sql); }) as typeof client.prepare;
    const sizes: number[] = []; const seen: number[] = []; const costs: number[] = [];
    let cursor: number | undefined;
    try {
      for (;;) {
        queries = 0;
        const page = f.templates.list({ limit: 20, ...(cursor ? { cursor } : {}) });
        costs.push(queries); sizes.push(page.items.length); seen.push(...page.items.map((item) => item.id));
        if (!page.hasMore) break;
        cursor = page.nextCursor!;
      }
    } finally { (client as { prepare: typeof client.prepare }).prepare = prepare; }
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(4);
  });

  it('uses the partial template index for run counts and a saved task\'s runs', () => {
    const f = setup();
    const plan = (sql: string) => JSON.stringify(f.store.connection.client.prepare(`explain query plan ${sql}`).all());
    expect(plan('select count(distinct e.task_id) n from execution_reuse r join execution e on e.id = r.execution_id where r.template_id = 1')).toContain('execution_reuse_template');
    expect(plan('select r.template_id, count(distinct e.task_id) from execution_reuse r join execution e on e.id = r.execution_id where r.template_id in (1, 2, 3) group by r.template_id')).toContain('execution_reuse_template');
  });
});
