// Shared FEAT-111 test support: the saved-task services wired over a verification
// harness, and an accepted first run to save. Not a test file, so importing it
// registers no `describe` blocks (memory: shared test support).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getIngestionConfig } from '../../config/env';
import { TemplateRepository } from '../../db/repositories/template-repository';
import { RuntimeEnvironmentRepository } from '../../db/repositories/runtime-environment-repository';
import { HistoryRepository } from '../../db/repositories/history-repository';
import { UploadFileStore, UploadService, ProfileService } from '../../ingestion/index';
import { SaveService, CompatibilityService, ReuseRunService, RepairService } from '../../reuse/index';
import type { FakePythonRun } from '../../execution/testing/fake-python-runner';
import { createVerificationHarness, type VerificationHarness } from './verification-harness';
import { finalizeStep, writeSteps } from './generation-harness';
import { stageProfiledUpload, sentinelCsv } from './generation-fixtures';

/** A real run that writes one declared output, so settle registers an artifact. */
export const PRODUCING: FakePythonRun = { onRun: (request) => {
  writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'totals.csv'), 'region,amount\nNorth,2\n');
  writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: '' }] }));
} };

/** Every saved-task service, built the way `app.ts` wires them. */
export function reuseServices(h: VerificationHarness) {
  const connection = h.store.connection;
  const templates = new TemplateRepository(connection);
  const runtime = new RuntimeEnvironmentRepository(connection);
  const history = new HistoryRepository(connection);
  const limits = getIngestionConfig(); const store = new UploadFileStore(h.store.paths);
  const uploads = new UploadService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, profiler: new ProfileService({ uploads: h.repos.uploads, profiles: h.repos.profiles, store, limits, logger: h.logger }), limits, logger: h.logger });
  const save = new SaveService({ connection, executions: h.repos.executions, tasks: h.repos.tasks, versions: h.repos.versions, approvals: h.repos.approvals, verifications: h.repos.verifications, profiles: h.repos.profiles, clarifications: h.repos.clarifications, events: h.repos.events, templates, reuse: h.repos.reuse, inputs: h.inputs, logger: h.logger });
  const compatibility = new CompatibilityService({ templates, reuse: h.repos.reuse, executions: h.repos.executions, uploads: h.repos.uploads, profiles: h.repos.profiles, runtime, logger: h.logger });
  const runs = new ReuseRunService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, versions: h.repos.versions, uploads, inputs: h.inputs, fixtures: h.fixtureService, workspace: h.workspace, verification: h.verification, compatibility, registry: h.registry, logger: h.logger });
  const repairs = new RepairService({ connection, tasks: h.repos.tasks, executions: h.repos.executions, templates, reuse: h.repos.reuse, uploads: h.repos.uploads, profiles: h.repos.profiles, uploadService: uploads, disclosure: h.disclosure, consents: h.repos.consents, preflight: h.preflight, compatibility, registry: h.registry, logger: h.logger });
  return { connection, templates, runtime, history, uploads, save, compatibility, runs, repairs };
}
export type ReuseServices = ReturnType<typeof reuseServices>;

/**
 * A harness whose first run was generated, verified, approved, run, and accepted.
 * Python runs are scripted generously so later reruns also produce an output.
 */
export async function acceptedHarness(options: { readonly extraRuns?: readonly FakePythonRun[]; readonly script?: string } = {}): Promise<VerificationHarness> {
  const pythonRuns = [{}, {}, PRODUCING, ...(options.extraRuns ?? []), ...Array.from({ length: 12 }, (_, index) => (index % 2 ? PRODUCING : {}))];
  const h = await createVerificationHarness({ pythonRuns, onApproved: () => undefined, ...(options.script ? { script: options.script } : {}) });
  await h.runToGate();
  await h.approve();
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
  h.review.review(h.execution.id, { verdict: 'accepted' });
  return h;
}

/** Stage one more profiled CSV shaped like the harness's first file. */
export function stageSimilar(h: VerificationHarness, name = 'next.csv', csv = sentinelCsv()) {
  return stageProfiledUpload(h.store.connection, h.store.paths, { name, bytes: Buffer.from(csv), format: 'csv' });
}

/** Check, start, verify, approve, run, and accept a saved-code run on a staged upload. */
export async function runSavedToCompletion(h: VerificationHarness, s: ReuseServices, templateId: number, uploadId: number) {
  const checked = s.compatibility.checkStaged(templateId, { uploadIds: [uploadId], timeZone: 'UTC' });
  const started = s.runs.start(templateId, { uploadIds: [uploadId], compatibilityDigest: checked.digest, asOf: checked.asOf, timeZone: 'UTC' });
  await h.settledPhases(started.execution.id);
  await h.approve(started.execution.id);
  await h.scriptRun.run(started.execution.id, new AbortController().signal);
  h.review.review(started.execution.id, { verdict: 'accepted' });
  return started;
}

/** Script the next provider session to write and finalize code that reads `input`. */
export function enqueueGeneration(h: VerificationHarness, input: string, requiredColumns: readonly { name: string; type: string }[] = [{ name: 'region', type: 'string' }]) {
  h.provider.enqueue([{ events: [], steps: [...writeSteps(input), finalizeStep(input, { declaredInputs: [{ fileRole: input, requiredColumns }] })], result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } } }]);
}

/** Count rows in a table, for "nothing was written" assertions. */
export function rows(h: VerificationHarness, table: string): number {
  return (h.store.connection.client.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
}

/**
 * Store a ready script runtime equal to the one a revision was approved on, or, with
 * `changed`, one whose pandas version and fingerprint differ, as FEAT-108 would after an upgrade.
 */
export function seedRuntime(s: ReuseServices, revision: { runtimeFingerprint: string; runtimeDetail: string }, changed = false) {
  const detail = JSON.parse(revision.runtimeDetail) as { pythonVersion: string; uvVersion: string; platform: string; arch: string; packages: { name: string; version: string }[] };
  const packages = changed ? [...detail.packages.filter((item) => item.name !== 'pandas'), { name: 'pandas', version: '9.9.9' }] : detail.packages;
  const row = s.runtime.open({ kind: 'script', specDigest: 'spec', lockDigest: changed ? 'lock-2' : 'lock', pythonVersion: detail.pythonVersion, uvVersion: detail.uvVersion, platform: detail.platform, arch: detail.arch });
  return s.runtime.settleReady(row.id, { fingerprint: changed ? 'c'.repeat(64) : revision.runtimeFingerprint, packages, launcherDigest: null, durationMs: 1 });
}
