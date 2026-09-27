import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionLimitReachedError, SAVED_CODE_CHECKS_FAILED, SAVED_CODE_TESTS_FAILED, describeRunState } from '@automate/core';
import { ReuseRunService } from '../../reuse/index';
import type { FakePythonRunner } from '../../execution/testing/fake-python-runner';
import type { VerificationHarness } from '../support/verification-harness';
import { acceptedHarness, reuseServices, rows, runSavedToCompletion, seedRuntime, stageSimilar } from '../support/reuse-harness';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });
async function saved(options: Parameters<typeof acceptedHarness>[0] = {}) {
  const h = await acceptedHarness(options); harnesses.push(h);
  const s = reuseServices(h);
  return { h, s, template: s.save.save(h.execution.id, { name: 'Monthly sales' }) };
}
/** Same columns as the first file, reordered, with one extra column in front. */
function reorderedCsv(rowCount = 40): string {
  const lines = ['note,ref,amount,region,order_id'];
  for (let index = 1; index <= rowCount; index += 1) lines.push(`n${index},r-${index},${index + 0.5},${['North', 'South'][index % 2]},${2000 + index}`);
  return `${lines.join('\n')}\n`;
}
/** Every file or directory name under a root. */
function names(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => [entry.name, ...(entry.isDirectory() ? names(path.join(root, entry.name)) : [])]);
}

describe('ReuseRunService.start: a saved task on another file', () => {
  it('runs the saved code on the new file through the whole gate with nothing sent to the AI', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'sales_oct.csv', reorderedCsv());
    const sessions = h.provider.sessions.length;
    const transmissions = rows(h, 'disclosure_transmission');
    seedRuntime(s, template.revision);
    const checked = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' });
    expect(checked.report.findings.map(({ code, severity, found }) => ({ code, severity, found }))).toEqual([{ code: 'extra_columns', severity: 'info', found: '1' }]);
    expect(checked.report.status).toBe('compatible');
    const started = s.runs.start(template.template.id, { uploadIds: [upload.id], compatibilityDigest: checked.digest, asOf: checked.asOf, timeZone: 'UTC' });
    expect(started.task.name).toBe('Monthly sales');
    await h.settledPhases(started.execution.id);
    const execution = h.repos.executions.getById(started.execution.id)!;
    expect(execution.status).toBe('awaiting_approval');
    expect(execution.asOfSource).toBe('now');
    const inputName = h.upload!.storedFilename;
    // The fixture was synthesized from the NEW file's profile, under the name the code reads.
    const fixture = readFileSync(path.join(h.store.paths.scriptsDir, String(execution.id), 'fixtures', inputName), 'utf8');
    expect(fixture.split(/\r?\n/)[0]).toBe('note,ref,amount,region,order_id');
    expect(h.intents.buildRunIntent(execution.id).intent).toMatchObject({ reuse: { templateName: 'Monthly sales', revisionNumber: 1, compatibility: { status: 'compatible' } }, asOf: { date: execution.asOfDate } });
    await h.approve(execution.id);
    await h.scriptRun.run(execution.id, new AbortController().signal);
    const runRequest = (h.runner as FakePythonRunner).requests.at(-1)!;
    expect(runRequest.env.AUTOMATE_AS_OF_DATE).toBe(execution.asOfDate);
    const staged = readFileSync(path.join(h.store.paths.runsDir, String(execution.id), 'input', inputName));
    expect(createHash('sha256').update(staged).digest('hex')).toBe(upload.sha256);
    expect(h.repos.artifacts.listByExecution(execution.id).every((artifact) => artifact.taskId === started.task.id)).toBe(true);
    expect(h.repos.artifacts.listByExecution(execution.id)).toHaveLength(1);
    h.review.review(execution.id, { verdict: 'accepted' });
    expect(h.repos.executions.getById(execution.id)!.status).toBe('completed');
    // The new upload's stored name never appears in this run's directories (TASK-004's invariant).
    const stored = h.repos.uploads.getById(upload.id)!.storedFilename;
    expect([...names(path.join(h.store.paths.scriptsDir, String(execution.id))), ...names(path.join(h.store.paths.runsDir, String(execution.id)))]).not.toContain(stored);
    expect(h.provider.sessions).toHaveLength(sessions);
    expect(rows(h, 'disclosure_transmission')).toBe(transmissions);
  });

  it('refuses an incompatible file, a stale digest, and a full slot with nothing written', async () => {
    const { h, s, template } = await saved();
    const renamed = await stageSimilar(h, 'renamed.csv', reorderedCsv().replace('region', 'area'));
    const checked = s.compatibility.checkStaged(template.template.id, { uploadIds: [renamed.id], timeZone: 'UTC' });
    expect(checked.report.status).toBe('incompatible');
    expect(checked.report.findings).toContainEqual(expect.objectContaining({ code: 'column_missing', column: 'region', severity: 'blocking', suggestion: null }));
    const counts = () => ['task', 'execution', 'execution_reuse', 'execution_input_binding', 'code_version'].map((table) => rows(h, table));
    const before = counts();
    expect(() => s.runs.start(template.template.id, { uploadIds: [renamed.id], compatibilityDigest: checked.digest, asOf: checked.asOf, timeZone: 'UTC' })).toThrow(expect.objectContaining({ code: 'INPUTS_INCOMPATIBLE' }));
    const fits = await stageSimilar(h, 'fits.csv', reorderedCsv());
    const fit = s.compatibility.checkStaged(template.template.id, { uploadIds: [fits.id], timeZone: 'UTC' });
    expect(() => s.runs.start(template.template.id, { uploadIds: [fits.id], compatibilityDigest: 'f'.repeat(64), asOf: fit.asOf, timeZone: 'UTC' })).toThrow(expect.objectContaining({ code: 'COMPATIBILITY_STALE' }));
    const atCapacity = new ReuseRunService({ connection: s.connection, tasks: h.repos.tasks, executions: h.repos.executions, templates: s.templates, reuse: h.repos.reuse, versions: h.repos.versions, uploads: s.uploads, inputs: h.inputs, fixtures: h.fixtureService, workspace: h.workspace, verification: h.verification, compatibility: s.compatibility, registry: { ...h.registry, assertCapacity: () => { throw new ExecutionLimitReachedError(); }, track: h.registry.track.bind(h.registry), publish: h.registry.publish.bind(h.registry) }, logger: h.logger });
    expect(() => atCapacity.start(template.template.id, { uploadIds: [fits.id], compatibilityDigest: fit.digest, asOf: fit.asOf, timeZone: 'UTC' })).toThrow(expect.objectContaining({ code: 'EXECUTION_LIMIT_REACHED' }));
    expect(counts()).toEqual(before);
    expect(h.repos.uploads.getById(renamed.id)!.taskId).toBeNull();
    expect(h.repos.uploads.getById(fits.id)!.taskId).toBeNull();
  });

  it('settles failed in the saved-task words when its own tests fail on the new file', async () => {
    // Python calls: generation tests, verification tests, real run; then this rerun's verification tests.
    const { h, s, template } = await saved({ extraRuns: [{ result: { outcome: 'failed', exitCode: 1, stdout: '1 failed in 0.10s\n' } }] });
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const checked = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' });
    const started = s.runs.start(template.template.id, { uploadIds: [upload.id], compatibilityDigest: checked.digest, asOf: checked.asOf, timeZone: 'UTC' });
    await h.settledPhases(started.execution.id);
    expect(h.repos.executions.getById(started.execution.id)).toMatchObject({ status: 'failed', errorCode: 'VERIFICATION_BLOCKED', errorMessage: `${SAVED_CODE_CHECKS_FAILED} ${SAVED_CODE_TESTS_FAILED}` });
  });

  it('rejecting a saved-code run records the feedback and creates no retry; writing new code is refused', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const checked = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' });
    const started = s.runs.start(template.template.id, { uploadIds: [upload.id], compatibilityDigest: checked.digest, asOf: checked.asOf, timeZone: 'UTC' });
    await h.settledPhases(started.execution.id);
    await h.approve(started.execution.id);
    await h.scriptRun.run(started.execution.id, new AbortController().signal);
    const executions = rows(h, 'execution');
    expect(h.review.review(started.execution.id, { verdict: 'rejected', feedback: 'The totals are wrong.' })).toEqual({ status: 'rejected', retryExecutionId: null, nextSteps: ['repair', 'replay'] });
    expect(h.repos.executions.getById(started.execution.id)).toMatchObject({ status: 'rejected', reviewFeedback: 'The totals are wrong.' });
    expect(() => h.service.retry(started.execution.id, 'Try again')).toThrow(expect.objectContaining({ code: 'RETRY_USES_SAVED_CODE' }));
    expect(rows(h, 'execution')).toBe(executions);
  });
});

describe('CompatibilityService: the runtime', () => {
  it('reports an unknown runtime, then a changed one with the concrete change, and binds the digest to it', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const unknown = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' });
    expect(unknown.report.findings).toContainEqual(expect.objectContaining({ code: 'runtime_unknown', severity: 'advisory' }));
    expect(s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' }).digest).toBe(unknown.digest);
    seedRuntime(s, template.revision, true);
    const changed = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' });
    expect(changed.report.status).toBe('compatible_with_warnings');
    expect(changed.report.findings).toContainEqual(expect.objectContaining({ code: 'runtime_changed', severity: 'advisory', found: expect.stringContaining('pandas') }));
    expect(changed.digest).not.toBe(unknown.digest);
    expect(JSON.stringify(changed)).not.toMatch(/ref-7919|QZX-/);
  });

  it('refuses an upload that already belongs to a task and reports one still being analyzed', async () => {
    const { h, s, template } = await saved();
    expect(() => s.compatibility.checkStaged(template.template.id, { uploadIds: [h.upload!.id], timeZone: 'UTC' })).toThrow(expect.objectContaining({ code: 'UPLOAD_ALREADY_ATTACHED' }));
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    h.store.connection.client.prepare("update upload set profile_status = 'profiling' where id = ?").run(upload.id);
    const report = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' }).report;
    expect(report).toMatchObject({ status: 'incompatible', findings: expect.arrayContaining([expect.objectContaining({ code: 'file_not_analyzed', severity: 'blocking' })]) });
  });
});

describe('ReuseRunService.replay: run again exactly', () => {
  it('reuses the code digest, the uploads under the same names, and the as-of date', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const second = await runSavedToCompletion(h, s, template.template.id, upload.id);
    const source = h.repos.executions.getById(second.execution.id)!;
    const replay = s.runs.replay(second.execution.id);
    await h.settledPhases(replay.id);
    const row = h.repos.executions.getById(replay.id)!;
    expect(row).toMatchObject({ taskId: source.taskId, trigger: 'rerun', retryOfExecutionId: source.id, status: 'awaiting_approval', asOfDate: source.asOfDate, asOfTimezone: source.asOfTimezone, asOfSource: 'copied' });
    expect(row.asOfAt).toEqual(source.asOfAt);
    expect(h.repos.reuse.listBindings(replay.id).map(({ uploadId, inputName, position }) => ({ uploadId, inputName, position }))).toEqual(h.repos.reuse.listBindings(source.id).map(({ uploadId, inputName, position }) => ({ uploadId, inputName, position })));
    expect(h.repos.reuse.getByExecution(replay.id)).toMatchObject({ kind: 'replay', templateName: 'Monthly sales', revisionNumber: 1 });
    expect(h.repos.versions.findFinal(replay.id)!.contentDigest).toBe(template.revision.contentDigest);
    await h.approve(replay.id);
    await h.scriptRun.run(replay.id, new AbortController().signal);
    const manifest = (id: number) => JSON.parse(h.repos.scriptRuns.getByExecution(id)!.inputManifest) as { sha256: string; inputName?: string }[];
    expect(manifest(replay.id).map(({ sha256, inputName }) => ({ sha256, inputName }))).toEqual(manifest(source.id).map(({ sha256, inputName }) => ({ sha256, inputName })));
  });

  it('refuses a generated run and a task with an open run, writing nothing', async () => {
    const { h, s, template } = await saved();
    expect(() => s.runs.replay(h.execution.id)).toThrow(expect.objectContaining({ code: 'REPLAY_NOT_AVAILABLE', message: 'Only a run of a saved task can be run again exactly.' }));
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const second = await runSavedToCompletion(h, s, template.template.id, upload.id);
    const replay = s.runs.replay(second.execution.id);
    await h.settledPhases(replay.id);
    const before = rows(h, 'execution');
    expect(() => s.runs.replay(second.execution.id)).toThrow(expect.objectContaining({ code: 'TASK_HAS_OPEN_RUN' }));
    expect(rows(h, 'execution')).toBe(before);
  });

  it('names a runtime upgrade at the gate and checks the code again on the new runtime', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const second = await runSavedToCompletion(h, s, template.template.id, upload.id);
    const before = h.repos.verifications.getLatest(second.execution.id)!;
    h.probe.upgrade({ pythonVersion: '3.15.0' });
    const replay = s.runs.replay(second.execution.id);
    await h.settledPhases(replay.id);
    const after = h.repos.verifications.getLatest(replay.id)!;
    expect(after.id).not.toBe(before.id);
    expect(after.runtimeFingerprint).not.toBe(before.runtimeFingerprint);
    expect(h.intents.buildRunIntent(replay.id).intent.reuse!.runtimeChanges).toEqual([expect.stringContaining('Python changed from')]);
    expect(h.repos.executions.getById(replay.id)!.asOfDate).toBe(h.repos.executions.getById(second.execution.id)!.asOfDate);
  });

  it('reads an interrupted saved-code run as Interrupted, replays it, and keeps a parked one through a restart', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const checked = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' });
    const started = s.runs.start(template.template.id, { uploadIds: [upload.id], compatibilityDigest: checked.digest, asOf: checked.asOf, timeZone: 'UTC' });
    await h.settledPhases(started.execution.id);
    // A parked run is not something a restart interrupts.
    expect(h.repos.executions.listActive().map((row) => row.id)).not.toContain(started.execution.id);
    expect(h.repos.executions.listParked().map((row) => row.id)).toContain(started.execution.id);
    // Simulate the server stopping while the run was being checked: reconciliation interrupts it.
    h.store.connection.client.prepare("update execution set status = 'verifying' where id = ?").run(started.execution.id);
    const interrupted = h.repos.executions.markInterrupted(started.execution.id);
    expect(describeRunState({ status: interrupted.status as 'failed', errorCode: interrupted.errorCode }).label).toBe('Interrupted');
    const replay = s.runs.replay(started.execution.id);
    await h.settledPhases(replay.id);
    expect(h.repos.executions.getById(replay.id)).toMatchObject({ status: 'awaiting_approval', asOfDate: interrupted.asOfDate, retryOfExecutionId: started.execution.id });
  });

  it('replays a run recorded before as-of dates by resolving now, and says so', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', reorderedCsv());
    const second = await runSavedToCompletion(h, s, template.template.id, upload.id);
    h.store.connection.client.prepare('update execution set as_of_at = null, as_of_date = null, as_of_timezone = null, as_of_source = null where id = ?').run(second.execution.id);
    const replay = s.runs.replay(second.execution.id);
    await h.settledPhases(replay.id);
    expect(h.repos.executions.getById(replay.id)!.asOfSource).toBe('now');
    const started = h.repos.events.listAfter(replay.id, 0, 500).events.find((event) => event.type === 'reuse_started');
    expect(started).toMatchObject({ asOfNotRecorded: true });
  });
});
