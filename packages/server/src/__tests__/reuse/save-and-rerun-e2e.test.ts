import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getIngestionConfig } from '../../config/env';
import { TemplateRepository } from '../../db/repositories/template-repository';
import { RuntimeEnvironmentRepository } from '../../db/repositories/runtime-environment-repository';
import { UploadFileStore, UploadService, ProfileService } from '../../ingestion/index';
import { SaveService, CompatibilityService, ReuseRunService } from '../../reuse/index';
import { createVerificationHarness, type VerificationHarness } from '../support/verification-harness';
import { stageProfiledUpload, sentinelCsv } from '../support/generation-fixtures';
import { createApp } from '../../app';
import { HistoryRepository } from '../../db/repositories/history-repository';
import { RepairService } from '../../reuse/index';
import { Value } from '@sinclair/typebox/value';
import { TemplateDetailResponseSchema, TemplateListResponseSchema, TemplateRevisionDetailResponseSchema } from '@automate/core';

const harnesses: VerificationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

async function accepted() {
  const producing = { onRun: (request: Parameters<NonNullable<import('../../execution/testing/fake-python-runner').FakePythonRun['onRun']>>[0]) => {
    writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'totals.csv'), 'region,amount\nNorth,2\n');
    writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: '' }] }));
  } };
  const h = await createVerificationHarness({ pythonRuns: [{}, {}, producing, {}, producing, {}, producing], onApproved: () => undefined });
  harnesses.push(h);
  await h.runToGate();
  await h.approve();
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
  h.review.review(h.execution.id, { verdict: 'accepted' });
  return h;
}

describe('saving and running accepted code on a second file', () => {
  it('copies the accepted version, checks another file, and reaches the approval gate without another provider session', async () => {
    const h = await accepted();
    const connection = h.store.connection;
    const templates = new TemplateRepository(connection);
    const runtime = new RuntimeEnvironmentRepository(connection);
    const save = new SaveService({ connection, executions: h.repos.executions, tasks: h.repos.tasks, versions: h.repos.versions, approvals: h.repos.approvals, verifications: h.repos.verifications, profiles: h.repos.profiles, clarifications: h.repos.clarifications, events: h.repos.events, templates, reuse: h.repos.reuse, inputs: h.inputs, logger: h.logger });
    expect(save.preview(h.execution.id).saveable).toBe(true);
    const saved = save.save(h.execution.id, { name: 'Sales totals' });
    expect(templates.list({ limit: 20 }).items[0]?.lastRunAt).toBeNull();
    expect(saved.revision.contentDigest).toBe(h.repos.versions.findFinal(h.execution.id)?.contentDigest);
    expect(templates.listFiles(saved.revision.id).map((file) => file.content)).toEqual(h.repos.versions.listFiles([h.repos.versions.findFinal(h.execution.id)!.id]).map((file) => file.content));
    expect(() => save.save(h.execution.id, {})).toThrow(expect.objectContaining({ code: 'EXECUTION_ALREADY_SAVED' }));
    const upload = await stageProfiledUpload(connection, h.store.paths, { name: 'new-sales.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' });
    const compatibility = new CompatibilityService({ templates, reuse: h.repos.reuse, executions: h.repos.executions, uploads: h.repos.uploads, profiles: h.repos.profiles, runtime, logger: h.logger });
    const checked = compatibility.checkStaged(saved.template.id, { uploadIds: [upload.id] });
    expect(checked.report.status).not.toBe('incompatible');
    const limits = getIngestionConfig();
    const store = new UploadFileStore(h.store.paths);
    const uploads = new UploadService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, profiler: new ProfileService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, limits, logger: h.logger }), limits, logger: h.logger });
    const run = new ReuseRunService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, versions: h.repos.versions, uploads, inputs: h.inputs, fixtures: h.fixtureService, workspace: h.workspace, verification: h.verification, compatibility, registry: h.registry, logger: h.logger });
    const sessions = h.provider.sessions.length;
    const transmissions = h.repos.transmissions.listByExecution(h.execution.id).length;
    const started = run.start(saved.template.id, { uploadIds: [upload.id], compatibilityDigest: checked.digest, asOf: checked.asOf });
    await h.settledPhases(started.execution.id);
    expect(h.repos.executions.getById(started.execution.id)?.status).toBe('awaiting_approval');
    expect(h.repos.reuse.listBindings(started.execution.id)).toEqual([expect.objectContaining({ uploadId: upload.id, inputName: h.upload!.storedFilename })]);
    expect(h.repos.versions.findFinal(started.execution.id)?.contentDigest).toBe(saved.revision.contentDigest);
    expect(h.provider.sessions).toHaveLength(sessions);
    expect(h.repos.transmissions.listByExecution(started.execution.id)).toHaveLength(0);
    expect(h.repos.transmissions.listByExecution(h.execution.id)).toHaveLength(transmissions);
  });
});

describe('historical replay', () => {
  it('reuses the second run after its saved task is deleted and leaves the provider untouched', async () => {
    const h = await accepted(); const connection = h.store.connection;
    const templates = new TemplateRepository(connection);
    const save = new SaveService({ connection, executions: h.repos.executions, tasks: h.repos.tasks, versions: h.repos.versions, approvals: h.repos.approvals, verifications: h.repos.verifications, profiles: h.repos.profiles, clarifications: h.repos.clarifications, events: h.repos.events, templates, reuse: h.repos.reuse, inputs: h.inputs, logger: h.logger });
    const saved = save.save(h.execution.id, { name: 'Sales totals' });
    const upload = await stageProfiledUpload(connection, h.store.paths, { name: 'next.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' });
    const compatibility = new CompatibilityService({ templates, reuse: h.repos.reuse, executions: h.repos.executions, uploads: h.repos.uploads, profiles: h.repos.profiles, runtime: new RuntimeEnvironmentRepository(connection), logger: h.logger });
    const checked = compatibility.checkStaged(saved.template.id, { uploadIds: [upload.id] });
    const limits = getIngestionConfig(); const store = new UploadFileStore(h.store.paths);
    const uploads = new UploadService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, profiler: new ProfileService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, limits, logger: h.logger }), limits, logger: h.logger });
    const run = new ReuseRunService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, versions: h.repos.versions, uploads, inputs: h.inputs, fixtures: h.fixtureService, workspace: h.workspace, verification: h.verification, compatibility, registry: h.registry, logger: h.logger });
    const before = connection.client.prepare('select count(*) n from task').get() as { n: number };
    expect(() => run.start(saved.template.id, { uploadIds: [upload.id], compatibilityDigest: '0'.repeat(64), asOf: checked.asOf })).toThrow(expect.objectContaining({ code: 'COMPATIBILITY_STALE' }));
    expect(connection.client.prepare('select count(*) n from task').get()).toEqual(before);
    const second = run.start(saved.template.id, { uploadIds: [upload.id], compatibilityDigest: checked.digest, asOf: checked.asOf });
    await h.settledPhases(second.execution.id);
    expect(templates.list({ limit: 20 }).items[0]?.lastRunAt).toBeInstanceOf(Date);
    await h.approve(second.execution.id);
    await h.scriptRun.run(second.execution.id, new AbortController().signal);
    h.review.review(second.execution.id, { verdict: 'accepted' });
    templates.delete(saved.template.id);
    const sessions = h.provider.sessions.length;
    const replay = run.replay(second.execution.id);
    await h.settledPhases(replay.id);
    expect(h.repos.executions.getById(replay.id)?.status).toBe('awaiting_approval');
    expect(h.repos.reuse.getByExecution(replay.id)?.templateId).toBeNull();
    expect(h.repos.reuse.listBindings(replay.id).map((binding) => [binding.uploadId, binding.inputName])).toEqual([[upload.id, h.upload!.storedFilename]]);
    expect(h.repos.versions.findFinal(replay.id)?.contentDigest).toBe(saved.revision.contentDigest);
    expect(h.repos.executions.getById(replay.id)?.asOfDate).toBe(h.repos.executions.getById(second.execution.id)?.asOfDate);
    expect(h.provider.sessions).toHaveLength(sessions);
    expect(h.repos.transmissions.listByExecution(replay.id)).toHaveLength(0);
  });
});

describe('saved-task HTTP routes', () => {
  it('serves code only from the revision route and starts a second task through the guarded API', async () => {
    const h = await accepted(); const connection = h.store.connection;
    const templates = new TemplateRepository(connection);
    const history = new HistoryRepository(connection);
    const save = new SaveService({ connection, executions: h.repos.executions, tasks: h.repos.tasks, versions: h.repos.versions, approvals: h.repos.approvals, verifications: h.repos.verifications, profiles: h.repos.profiles, clarifications: h.repos.clarifications, events: h.repos.events, templates, reuse: h.repos.reuse, inputs: h.inputs, logger: h.logger });
    const compatibility = new CompatibilityService({ templates, reuse: h.repos.reuse, executions: h.repos.executions, uploads: h.repos.uploads, profiles: h.repos.profiles, runtime: new RuntimeEnvironmentRepository(connection), logger: h.logger });
    const limits = getIngestionConfig(); const store = new UploadFileStore(h.store.paths);
    const uploads = new UploadService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, profiler: new ProfileService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, limits, logger: h.logger }), limits, logger: h.logger });
    const runs = new ReuseRunService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, versions: h.repos.versions, uploads, inputs: h.inputs, fixtures: h.fixtureService, workspace: h.workspace, verification: h.verification, compatibility, registry: h.registry, logger: h.logger });
    const repairs = new RepairService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, uploads: h.repos.uploads, profiles: h.repos.profiles, uploadService: uploads, disclosure: h.disclosure, consents: h.repos.consents, preflight: h.preflight, compatibility, registry: h.registry, logger: h.logger });
    const config = { host: '127.0.0.1', port: 0, logLevel: 'silent' as const, maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };
    const app = createApp({ logger: h.logger, dataRoot: h.store.root, version: 'test', paths: h.store.paths, getSchemaVersion: () => '11', serverConfig: config, conversation: { tasks: h.repos.tasks, executions: h.repos.executions, events: h.repos.events, registry: h.registry, disclosure: h.disclosure, preflight: h.preflight, consents: h.repos.consents }, templates: { templates, reuse: h.repos.reuse, history, executions: h.repos.executions, save, compatibility, runs, repairs } });
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener.');
      config.port = address.port;
      const base = `http://127.0.0.1:${address.port}`;
      const post = (path: string, body: unknown, origin = base) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
      const savedResponse = await post(`/executions/${h.execution.id}/save`, { name: 'Totals' });
      expect(savedResponse.status).toBe(201);
      const saved = await savedResponse.json() as { template: { id: number }; revision: { id: number } };
      const list = await (await fetch(`${base}/api/templates`)).json() as unknown;
      const detail = await (await fetch(`${base}/api/templates/${saved.template.id}`)).json() as unknown;
      const revision = await (await fetch(`${base}/api/template-revisions/${saved.revision.id}`)).json() as unknown;
      expect(Value.Check(TemplateListResponseSchema, list)).toBe(true);
      expect(Value.Check(TemplateDetailResponseSchema, detail)).toBe(true);
      expect(Value.Check(TemplateRevisionDetailResponseSchema, revision)).toBe(true);
      const code = h.repos.versions.listFiles([h.repos.versions.findFinal(h.execution.id)!.id])[0]!.content;
      expect(JSON.stringify(list)).not.toContain(code);
      expect(JSON.stringify(detail)).not.toContain(code);
      expect((revision as { files: { content: string }[] }).files.some((file) => file.content === code)).toBe(true);
      const upload = await stageProfiledUpload(connection, h.store.paths, { name: 'next.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' });
      const check = await (await fetch(`${base}/api/templates/${saved.template.id}/compatibility?uploadIds=${upload.id}&timeZone=UTC`)).json() as { digest: string; asOf: unknown };
      expect((await post(`/templates/${saved.template.id}/runs`, { uploadIds: [upload.id], compatibilityDigest: check.digest, asOf: check.asOf }, 'http://elsewhere.invalid')).status).toBe(403);
      const started = await post(`/templates/${saved.template.id}/runs`, { uploadIds: [upload.id], compatibilityDigest: check.digest, asOf: check.asOf });
      expect(started.status).toBe(201);
      expect((await started.json() as { task: { id: number } }).task.id).toBeGreaterThan(h.task.id);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe('AI repair boundary', () => {
  it('persists preflight choices inside the task transaction', async () => {
    const h = await accepted();
    const original = h.repos.clarifications.listByExecution(h.execution.id).length;
    h.store.connection.db.transaction((tx) => {
      h.preflight.persist(h.execution.id, [{ findingKey: '0:date:ambiguous_date_format', impact: 'meaning', promptText: 'Which date order?', rationale: 'Two interpretations are possible.', options: [{ value: 'DMY', label: 'Day first' }], proposedDefault: 'DMY', answer: 'DMY', answerSource: 'user' }], tx);
    });
    const batches = h.repos.clarifications.listByExecution(h.execution.id);
    expect(batches).toHaveLength(original + 1);
    expect(batches.at(-1)?.questions[0]?.answer).toBe('DMY');
  });

  it('requires new disclosure consent and sends the mapping note without the saved code', async () => {
    const h = await accepted(); const connection = h.store.connection;
    const templates = new TemplateRepository(connection);
    const save = new SaveService({ connection, executions: h.repos.executions, tasks: h.repos.tasks, versions: h.repos.versions, approvals: h.repos.approvals, verifications: h.repos.verifications, profiles: h.repos.profiles, clarifications: h.repos.clarifications, events: h.repos.events, templates, reuse: h.repos.reuse, inputs: h.inputs, logger: h.logger });
    const saved = save.save(h.execution.id, { name: 'Totals' });
    const upload = await stageProfiledUpload(connection, h.store.paths, { name: 'different.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' });
    const compatibility = new CompatibilityService({ templates, reuse: h.repos.reuse, executions: h.repos.executions, uploads: h.repos.uploads, profiles: h.repos.profiles, runtime: new RuntimeEnvironmentRepository(connection), logger: h.logger });
    const limits = getIngestionConfig(); const store = new UploadFileStore(h.store.paths);
    const uploads = new UploadService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, profiler: new ProfileService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, limits, logger: h.logger }), limits, logger: h.logger });
    const repair = new RepairService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, uploads: h.repos.uploads, profiles: h.repos.profiles, uploadService: uploads, disclosure: h.disclosure, consents: h.repos.consents, preflight: h.preflight, compatibility, registry: h.registry, logger: h.logger });
    const mapping = { columns: [], sheets: [], decisions: [], note: 'Use the new regional labels.' };
    await expect(repair.startFromTemplate(saved.template.id, { uploadIds: [upload.id], mapping, consent: { consentId: 1_000_000, payloadDigest: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'DISCLOSURE_CONSENT_REQUIRED' });
    const preview = h.disclosure.buildPreview([upload.id]);
    const consent = h.disclosure.grantConsent({ uploadIds: [upload.id], payloadDigest: preview.digest, scopeDiagnostics: true });
    h.provider.enqueue([{ events: [], steps: [], result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 0 } } }]);
    const created = await repair.startFromTemplate(saved.template.id, { uploadIds: [upload.id], mapping, consent: { consentId: consent.id, payloadDigest: consent.payloadDigest } });
    await h.settledPhases(created.execution.id);
    const prompt = h.provider.sessions[1]?.prompts[0] ?? '';
    expect(prompt).toContain('Use the new regional labels.');
    expect(prompt).toContain('different.csv');
    expect(prompt).not.toContain('frame.groupby("region")');
    expect(h.repos.transmissions.listByExecution(created.execution.id).some((row) => row.kind === 'context')).toBe(true);
    expect(h.repos.reuse.getByExecution(created.execution.id)?.kind).toBe('repair');
  });
});
