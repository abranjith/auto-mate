// Shared FEAT-109 test support: a temporary data root with a task, an
// execution, a sealed version, an approval, and an opened script run — the
// state the registrar and the artifact routes start from. A plain module, not
// a `.test.ts`, so importing it never re-registers another suite's tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeDetail } from '@automate/core';
import { ApprovalRepository } from '../../db/repositories/approval-repository';
import { ArtifactRepository, type NewArtifactRow } from '../../db/repositories/artifact-repository';
import { CodeVersionRepository } from '../../db/repositories/code-version-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { ScriptRunRepository, type ScriptRunRow } from '../../db/repositories/script-run-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { VerificationRepository } from '../../db/repositories/verification-repository';
import { createTempStore, type TempStore } from './ingestion-fixtures';

const FP = 'f'.repeat(64);
const RUNTIME: RuntimeDetail = { pythonVersion: '3.14.6', uvVersion: 'uv 0.9.0', platform: 'linux', arch: 'x64', packages: [] };

export interface RunFixture {
  readonly store: TempStore;
  readonly taskId: number;
  readonly executionId: number;
  readonly run: ScriptRunRow;
  readonly outputDir: string;
  readonly tasks: TaskRepository;
  readonly executions: ExecutionRepository;
  readonly scriptRuns: ScriptRunRepository;
  readonly artifacts: ArtifactRepository;
}

/**
 * Create a task whose execution is `executing` with an opened (running) script run and an empty `runs/{id}/output/`.
 * @param options A prefix for the temp root, or an existing store to reuse.
 */
export function createRunFixture(options: { prefix?: string; store?: TempStore } = {}): RunFixture {
  const store = options.store ?? createTempStore(options.prefix ?? 'automate-artifact-');
  const c = store.connection;
  const tasks = new TaskRepository(c);
  const created = tasks.createWithExecution('Summarize sales by month');
  const executions = new ExecutionRepository(c);
  const versions = new CodeVersionRepository(c);
  const draft = versions.openDraft(created.execution.id, 1);
  versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'print(1)\n' });
  const sealed = versions.seal(draft.id);
  executions.markStarted(created.execution.id);
  executions.transitionStatus(created.execution.id, 'verifying');
  executions.transitionStatus(created.execution.id, 'awaiting_approval');
  const verifications = new VerificationRepository(c);
  const pass = verifications.open({ executionId: created.execution.id, codeVersionId: sealed.id, contentDigest: sealed.contentDigest!, runtimeFingerprint: FP, runtimeDetail: RUNTIME });
  verifications.settle(pass.id, { status: 'passed', summary: 's', durationMs: 1, checks: [] });
  new ApprovalRepository(c).decide({ executionId: created.execution.id, codeVersionId: sealed.id, verificationRunId: pass.id, contentDigest: sealed.contentDigest!, runtimeFingerprint: FP, intentDigest: 'i'.repeat(64), decision: 'approved', acknowledgedWarnings: false }, 'executing');
  const scriptRuns = new ScriptRunRepository(c);
  const run = scriptRuns.openGated({ executionId: created.execution.id, codeVersionId: sealed.id, contentDigest: sealed.contentDigest!, runtimeFingerprint: FP, dirPath: `runs/${created.execution.id}`, inputs: [] });
  const outputDir = path.join(store.paths.runsDir, String(created.execution.id), 'output');
  mkdirSync(outputDir, { recursive: true });
  return { store, taskId: created.task.id, executionId: created.execution.id, run, outputDir, tasks, executions, scriptRuns, artifacts: new ArtifactRepository(c) };
}

/** Write a file into the run's output directory. @returns Its absolute path. */
export function writeOutput(fixture: RunFixture, name: string, content: string | Buffer): string {
  const file = path.join(fixture.outputDir, name);
  writeFileSync(file, content);
  return file;
}

/** Write `manifest.json` declaring the given entries. */
export function writeManifest(fixture: RunFixture, entries: readonly { filename: string; type: string; title?: string; description?: string }[]): string {
  return writeOutput(fixture, 'manifest.json', JSON.stringify({ artifacts: entries.map((entry) => ({ title: entry.filename, description: '', ...entry })) }));
}

/** A valid artifact row for the fixture's run, for repository tests that do not go through the registrar. */
export function artifactRow(fixture: RunFixture, id: number, overrides: Partial<NewArtifactRow> = {}): NewArtifactRow {
  return { id, executionId: fixture.executionId, taskId: fixture.taskId, scriptRunId: fixture.run.id, filename: `out-${id}.csv`, filePath: `artifacts/${fixture.taskId}/${id}.csv`, type: 'csv', extension: '.csv', mimeType: 'text/csv; charset=utf-8', renderMode: 'table', declared: true, title: null, description: null, byteSize: 3, sha256: 'a'.repeat(64), contentScan: null, ...overrides };
}
