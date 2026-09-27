import { afterEach, describe, expect, it } from 'vitest';
import { renderMappingInstructions, type InputContract, type RepairMapping } from '@automate/core';
import type { VerificationHarness } from '../support/verification-harness';
import { MAIN_PY } from '../support/generation-harness';
import { acceptedHarness, enqueueGeneration, reuseServices, rows, runSavedToCompletion, stageSimilar, type ReuseServices } from '../support/reuse-harness';

const SAVED_CODE_SENTINEL = 'SAVED-CODE-SENTINEL-91';
const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

function csv(header: string, rowCount = 40): string {
  const lines = [header];
  for (let index = 1; index <= rowCount; index += 1) lines.push(`${3000 + index},${['North', 'South'][index % 2]},${index + 0.5},r-${index}`);
  return `${lines.join('\n')}\n`;
}
async function saved() {
  const h = await acceptedHarness({ script: `${MAIN_PY}# ${SAVED_CODE_SENTINEL}\n` }); harnesses.push(h);
  const s = reuseServices(h);
  return { h, s, template: s.save.save(h.execution.id, { name: 'Monthly sales' }) };
}
function consentFor(h: VerificationHarness, uploadIds: readonly number[], taskId?: number) {
  const preview = h.disclosure.buildPreview(uploadIds);
  const granted = h.disclosure.grantConsent({ uploadIds, payloadDigest: preview.digest, scopeDiagnostics: true, ...(taskId === undefined ? {} : { taskId }) });
  return { consentId: granted.id, payloadDigest: granted.payloadDigest };
}
function contractOf(s: ReuseServices, templateId: number): InputContract {
  return JSON.parse(s.templates.getCurrentRevision(templateId)!.inputContract) as InputContract;
}

describe('RepairService.startFromTemplate: mapping, repair, and promotion', () => {
  it('rejects an invalid mapping before anything is written', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'nov.csv', csv('order_id,area,amount,ref'));
    const consent = consentFor(h, [upload.id]);
    const before = ['task', 'execution', 'execution_reuse'].map((table) => rows(h, table));
    const attempt = (mapping: RepairMapping) => s.repairs.startFromTemplate(template.template.id, { uploadIds: [upload.id], mapping, consent, timeZone: 'UTC' });
    await expect(attempt({ columns: [], sheets: [], decisions: [], note: null })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('every missing item') });
    await expect(attempt({ columns: [{ inputPosition: 0, sheet: null, expected: 'region', use: 'nowhere' }], sheets: [], decisions: [], note: null })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('nowhere') });
    await expect(attempt({ columns: [{ inputPosition: 0, sheet: null, expected: 'amount', use: 'area' }], sheets: [], decisions: [], note: null })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('amount') });
    expect(['task', 'execution', 'execution_reuse'].map((table) => rows(h, table))).toEqual(before);
    expect(h.repos.uploads.getById(upload.id)!.taskId).toBeNull();
  });

  it('sends the mapping sentences and the new disclosure, never the saved code, then promotes an accepted repair to revision 2', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'nov.csv', csv('order_id,area,amount,ref'));
    const report = s.compatibility.checkStaged(template.template.id, { uploadIds: [upload.id], timeZone: 'UTC' }).report;
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'column_missing', column: 'region' }));
    const mapping: RepairMapping = { columns: [{ inputPosition: 0, sheet: null, expected: 'region', use: 'area' }], sheets: [], decisions: [], note: 'Regions are now called areas.' };
    const sentences = renderMappingInstructions(mapping, contractOf(s, template.template.id));
    expect(sentences).toBe('Adapt the saved task for the new file using these choices:\nIn the first file, use the column “area” wherever the saved task used “region”.\nRegions are now called areas.');
    enqueueGeneration(h, upload.storedFilename, [{ name: 'area', type: 'string' }]);
    const sessions = h.provider.sessions.length;
    const repair = await s.repairs.startFromTemplate(template.template.id, { uploadIds: [upload.id], mapping, consent: consentFor(h, [upload.id]), timeZone: 'UTC' });
    await h.settledPhases(repair.execution.id);
    expect(h.provider.sessions).toHaveLength(sessions + 1);
    const prompt = h.provider.sessions.at(-1)!.prompts.join('\n');
    for (const line of sentences.split('\n')) expect(prompt).toContain(line);
    expect(prompt).toContain('area');
    expect(prompt).not.toContain(SAVED_CODE_SENTINEL);
    expect(h.repos.reuse.getByExecution(repair.execution.id)).toMatchObject({ kind: 'repair', templateId: template.template.id, revisionNumber: 1 });
    expect(h.repos.reuse.listBindings(repair.execution.id)).toEqual([]);
    expect(h.repos.executions.getById(repair.execution.id)).toMatchObject({ status: 'awaiting_approval', guidance: sentences, asOfTimezone: 'UTC', asOfSource: 'now' });
    await h.approve(repair.execution.id);
    await h.scriptRun.run(repair.execution.id, new AbortController().signal);
    h.review.review(repair.execution.id, { verdict: 'accepted' });
    expect(s.save.preview(repair.execution.id).promoteTarget).toEqual({ templateId: template.template.id, name: 'Monthly sales', nextRevisionNumber: 2 });
    const revision1 = s.templates.getRevision(template.revision.id)!;
    const files1 = s.templates.listFiles(template.revision.id);
    const promoted = s.save.save(repair.execution.id, { templateId: template.template.id });
    expect(promoted.revision).toMatchObject({ templateId: template.template.id, revisionNumber: 2, note: sentences });
    expect(s.templates.getRevision(template.revision.id)).toEqual(revision1);
    expect(s.templates.listFiles(template.revision.id)).toEqual(files1);
    expect(() => h.store.connection.client.prepare('update template_revision set note = ? where id = ?').run('x', template.revision.id)).toThrow(/immutable/);
    // December: the promoted revision runs on a file with `area`, with no AI at all.
    const december = await stageSimilar(h, 'dec.csv', csv('order_id,area,amount,ref'));
    const quiet = h.provider.sessions.length;
    const run = await runSavedToCompletion(h, s, template.template.id, december.id);
    expect(h.repos.versions.findFinal(run.execution.id)!.contentDigest).toBe(promoted.revision.contentDigest);
    expect(h.repos.reuse.getByExecution(run.execution.id)).toMatchObject({ kind: 'run', revisionNumber: 2 });
    expect(h.repos.executions.getById(run.execution.id)!.status).toBe('completed');
    expect(h.provider.sessions).toHaveLength(quiet);
  });
});

describe('RepairService.repairExecution: repair after a saved-code run', () => {
  it('takes a fresh consent for the existing task, links the new run, and respects one open run per task', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', csv('order_id,region,amount,ref'));
    const run = await runSavedToCompletion(h, s, template.template.id, upload.id);
    const consent = consentFor(h, [upload.id], run.task.id);
    enqueueGeneration(h, h.repos.uploads.getById(upload.id)!.storedFilename);
    const created = s.repairs.repairExecution(run.execution.id, { consent, note: 'Round the totals.' });
    const source = h.repos.executions.getById(run.execution.id)!;
    expect(created.execution).toMatchObject({ taskId: run.task.id, trigger: 'rerun', retryOfExecutionId: run.execution.id, asOfDate: source.asOfDate, asOfTimezone: source.asOfTimezone, asOfSource: 'copied' });
    expect(h.repos.consents.findLiveForTask(run.task.id)?.id).toBe(consent.consentId);
    expect(h.repos.reuse.getByExecution(created.execution.id)).toMatchObject({ kind: 'repair', templateId: template.template.id });
    expect(() => s.repairs.repairExecution(run.execution.id, { consent, note: 'Again' })).toThrow(expect.objectContaining({ code: 'REPLAY_NOT_AVAILABLE' }));
    await h.settledPhases(created.execution.id);
  });

  it('refuses a mapping once the saved task is deleted, and accepts a note-only repair', async () => {
    const { h, s, template } = await saved();
    const upload = await stageSimilar(h, 'next.csv', csv('order_id,region,amount,ref'));
    const run = await runSavedToCompletion(h, s, template.template.id, upload.id);
    s.templates.delete(template.template.id);
    const consent = consentFor(h, [upload.id], run.task.id);
    const mapping: RepairMapping = { columns: [], sheets: [], decisions: [], note: 'x' };
    expect(() => s.repairs.repairExecution(run.execution.id, { consent, mapping })).toThrow(expect.objectContaining({ message: expect.stringContaining('Add a note') }));
    enqueueGeneration(h, h.repos.uploads.getById(upload.id)!.storedFilename);
    const created = s.repairs.repairExecution(run.execution.id, { consent, note: 'Round the totals.' });
    expect(h.repos.reuse.getByExecution(created.execution.id)).toMatchObject({ kind: 'repair', templateId: null, compatibilityReport: null, templateName: 'Monthly sales' });
    await h.settledPhases(created.execution.id);
  });
});
