import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveService } from '../../reuse/index';
import type { VerificationHarness } from '../support/verification-harness';
import { acceptedHarness, reuseServices, rows } from '../support/reuse-harness';
import { MAIN_PY } from '../support/generation-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });
async function setup(options: Parameters<typeof acceptedHarness>[0] = {}) {
  const h = await acceptedHarness(options); harnesses.push(h);
  return { h, s: reuseServices(h) };
}
const TEMPLATE_TABLES = ['task_template', 'template_revision', 'template_revision_file'];
const templateRows = (h: VerificationHarness) => TEMPLATE_TABLES.map((table) => rows(h, table));

describe('SaveService.save: the saved revision', () => {
  it('copies the accepted code byte for byte, the contract, the runtime, and appends task_saved', async () => {
    const { h, s } = await setup();
    const version = h.repos.versions.findFinal(h.execution.id)!;
    const saved = s.save.save(h.execution.id, { name: '  Monthly sales summary  ' });
    expect(saved.template.name).toBe('Monthly sales summary');
    expect(saved.template.description).toBe(h.task.description);
    expect(saved.revision).toMatchObject({ revisionNumber: 1, contentDigest: version.contentDigest, sourceExecutionId: h.execution.id, note: null });
    const originals = h.repos.versions.listFiles([version.id]).map(({ path, content, sha256 }) => ({ path, content, sha256 }));
    expect(s.templates.listFiles(saved.revision.id).map(({ path, content, sha256 }) => ({ path, content, sha256 }))).toEqual(originals);
    const contract = JSON.parse(saved.revision.inputContract) as { inputs: { inputName: string; label: string; declared: boolean; tables: { selector: unknown; columns: { name: string; required: boolean; declaredType: string | null }[] }[] }[] };
    expect(contract.inputs).toHaveLength(1);
    expect(contract.inputs[0]).toMatchObject({ inputName: h.upload!.storedFilename, label: h.upload!.originalFilename, declared: true, tables: [{ selector: { kind: 'only' } }] });
    expect(contract.inputs[0]!.tables[0]!.columns.map((column) => column.name)).toEqual(['order_id', 'region', 'amount', 'ref']);
    expect(contract.inputs[0]!.tables[0]!.columns.filter((column) => column.required)).toEqual([expect.objectContaining({ name: 'region', declaredType: 'string' })]);
    const approval = h.repos.approvals.getGranted(h.execution.id)!;
    expect(saved.revision.runtimeFingerprint).toBe(h.repos.verifications.getById(approval.verificationRunId)!.runtimeFingerprint);
    expect(saved.revision.readsWallClock).toBe(false);
    expect(h.repos.events.listAfter(h.execution.id, 0, 500).events.at(-1)).toMatchObject({ type: 'task_saved', templateId: saved.template.id, name: 'Monthly sales summary', revisionNumber: 1 });
  });

  it('keeps no sample row or frequent value, and uses the task name for a blank name', async () => {
    const { h, s } = await setup();
    const profile = h.repos.profiles.listByUpload(h.upload!.id)[0]!;
    const sample = String(profile.sampleRows[0]![3]);
    const frequent = profile.columns.find((column) => column.name === 'region')!.topValues![0]!.value;
    const saved = s.save.save(h.execution.id, { name: '   ' });
    expect(saved.template.name).toBe(h.task.name);
    const stored = JSON.stringify(h.store.connection.client.prepare('select * from template_revision').all()) + JSON.stringify(h.store.connection.client.prepare('select * from task_template').all());
    expect(stored).not.toContain(sample);
    expect(stored).not.toContain(frequent);
  });

  it('records a direct clock read in main.py, but not one only in a test file', async () => {
    const { h, s } = await setup({ script: MAIN_PY.replace('def main():', 'def main():\n    stamp = date.today()') });
    const preview = s.save.preview(h.execution.id);
    expect(preview.readsWallClock).toEqual([{ path: 'main.py', line: 5 }]);
    expect(s.save.save(h.execution.id, {}).revision.readsWallClock).toBe(true);
  });

  it('logs ids and counts, never the name, description, or a column name', async () => {
    const { h } = await setup();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const save = new SaveService({ connection: h.store.connection, executions: h.repos.executions, tasks: h.repos.tasks, versions: h.repos.versions, approvals: h.repos.approvals, verifications: h.repos.verifications, profiles: h.repos.profiles, clarifications: h.repos.clarifications, events: h.repos.events, templates: reuseServices(h).templates, reuse: h.repos.reuse, inputs: h.inputs, logger });
    save.save(h.execution.id, { name: 'Quarterly secret name' });
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(logged).toContain('"executionId"');
    for (const secret of ['Quarterly secret name', h.task.description, 'region', h.upload!.originalFilename]) expect(logged).not.toContain(secret);
  });
});

describe('SaveService.save: refusals write nothing', () => {
  it('refuses a run that was not accepted, naming its state in History words', async () => {
    const { h, s } = await setup();
    const other = h.repos.tasks.createWithExecution('Another request');
    expect(() => s.save.save(other.execution.id, {})).toThrow(expect.objectContaining({ code: 'EXECUTION_NOT_SAVEABLE', message: expect.stringContaining('“Starting”') }));
    h.repos.executions.markSettled(other.execution.id, { status: 'failed' });
    expect(() => s.save.save(other.execution.id, {})).toThrow(expect.objectContaining({ code: 'EXECUTION_NOT_SAVEABLE', message: expect.stringContaining('Only a run you accepted can be saved.') }));
    expect(s.save.preview(other.execution.id)).toMatchObject({ saveable: false, alreadySaved: null });
    expect(templateRows(h)).toEqual([0, 0, 0]);
  });

  it('refuses a second save with the saved task id and revision number', async () => {
    const { h, s } = await setup();
    const saved = s.save.save(h.execution.id, {});
    expect(() => s.save.save(h.execution.id, {})).toThrow(expect.objectContaining({ code: 'EXECUTION_ALREADY_SAVED', templateId: saved.template.id, revisionNumber: 1 }));
    expect(s.save.preview(h.execution.id).alreadySaved).toEqual({ templateId: saved.template.id, name: saved.template.name, revisionNumber: 1 });
    expect(templateRows(h)).toEqual([1, 1, 2]);
  });

  it('refuses a 121-character name', async () => {
    const { h, s } = await setup();
    expect(() => s.save.save(h.execution.id, { name: 'x'.repeat(121) })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(templateRows(h)).toEqual([0, 0, 0]);
  });

  it('refuses tampered code with REVISION_INTEGRITY', async () => {
    const { h, s } = await setup();
    const version = h.repos.versions.findFinal(h.execution.id)!;
    const client = h.store.connection.client;
    const triggers = client.prepare("select name, sql from sqlite_master where type = 'trigger' and tbl_name = 'code_file'").all() as { name: string; sql: string }[];
    for (const trigger of triggers) client.exec(`drop trigger ${trigger.name}`);
    client.prepare("update code_file set content = content || '\n# tampered' where code_version_id = ? and path = 'main.py'").run(version.id);
    expect(() => s.save.save(h.execution.id, {})).toThrow(expect.objectContaining({ code: 'REVISION_INTEGRITY' }));
    expect(templateRows(h)).toEqual([0, 0, 0]);
  });

  it('refuses to promote a run that is not a repair of that saved task', async () => {
    const { h, s } = await setup();
    const saved = s.save.save(h.execution.id, {});
    const retry = h.service.retry(h.execution.id, 'Again');
    await h.runToGate(retry.execution);
    await h.approve(retry.execution.id);
    await h.scriptRun.run(retry.execution.id, new AbortController().signal);
    h.review.review(retry.execution.id, { verdict: 'accepted' });
    expect(() => s.save.save(retry.execution.id, { templateId: saved.template.id })).toThrow(expect.objectContaining({ code: 'EXECUTION_NOT_SAVEABLE', message: expect.stringContaining('wasn’t made from that saved task') }));
    expect(templateRows(h)).toEqual([1, 1, 2]);
  });
});

describe('a saved task is independent of its source task', () => {
  it('survives deleting the source task: provenance clears, everything else is unchanged', async () => {
    const { h, s } = await setup();
    const saved = s.save.save(h.execution.id, { name: 'Monthly' });
    expect(s.history.taskCounts(h.task.id).savedAs).toEqual(['Monthly']);
    const before = s.templates.getRevision(saved.revision.id)!;
    const files = s.templates.listFiles(saved.revision.id);
    await h.quiesce();
    h.repos.tasks.deleteOwnedRows(h.task.id);
    expect(s.templates.getRevision(saved.revision.id)).toEqual({ ...before, sourceExecutionId: null });
    expect(s.templates.listFiles(saved.revision.id)).toEqual(files);
    const client = h.store.connection.client;
    const populated = (client.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('__drizzle_migrations', 'app_meta', 'conversation_event_kind', 'runtime_environment')").all() as { name: string }[])
      .map(({ name }) => name).filter((name) => rows(h, name) > 0);
    // Staged uploads are not task-owned (FEAT-104's sweep owns them); only the template tables remain.
    expect(populated.filter((name) => name !== 'upload' && name !== 'upload_profile' && name !== 'upload_column').sort()).toEqual([...TEMPLATE_TABLES].sort());
  });
});
