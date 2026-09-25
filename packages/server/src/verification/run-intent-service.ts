// ---------------------------------------------------------------------------
// The run intent (FEAT-107 TASK-010): the single assembly point for
// everything the approval gate shows a person, built from STORED ROWS ONLY —
// no probe, no clock, no filesystem — so the same state always yields the
// same object and the same digest. The server rebuilds it when a decision
// arrives and rejects a digest that no longer matches: a person approves what
// they saw, not what the server would run now.
//
// No absolute path appears: inputs are named by the person's original
// filename (a display label), outputs by their declared filename.
// ---------------------------------------------------------------------------

import {
  ExecutionNotFoundError,
  RUN_INTENT_CAVEATS,
  VerificationBlockedError,
  VerificationNotFoundError,
  buildIntentDigest,
  countLines,
  describeRuntime,
  parseOutputManifest,
  shortDigest,
  type CheckKey,
  type CheckStatus,
  type RunIntent,
  type RuntimeDetail,
} from '@automate/core';
import type { CodeVersionRepository, CodeVersionWithFiles } from '../db/repositories/code-version-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { VerificationRepository, VerificationRunWithChecks } from '../db/repositories/verification-repository';

export interface RunIntentServiceDependencies {
  readonly executions: ExecutionRepository;
  readonly versions: CodeVersionRepository;
  readonly verifications: VerificationRepository;
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
}

/** An intent and the digest an approval must carry. */
export interface BuiltIntent {
  readonly intent: RunIntent;
  readonly intentDigest: string;
  readonly run: VerificationRunWithChecks;
  readonly version: CodeVersionWithFiles;
}

const detailOf = (run: VerificationRunWithChecks, key: CheckKey): Record<string, unknown> => {
  const text = run.checks.find(({ checkKey }) => checkKey === key)?.detail ?? null;
  try { return text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { return {}; }
};
const count = (value: unknown) => (typeof value === 'number' ? value : null);

/** Builds the gate's intent from stored rows. */
export class RunIntentService {
  constructor(private readonly deps: RunIntentServiceDependencies) {}

  /**
   * Assemble the intent for an execution's latest passed verification.
   * @throws ExecutionNotFoundError; VerificationNotFoundError before any pass; VerificationBlockedError when the latest pass does not allow the run.
   */
  buildRunIntent(executionId: number): BuiltIntent {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    const latest = this.deps.verifications.getLatest(executionId);
    if (!latest) throw new VerificationNotFoundError(executionId);
    const run = this.deps.verifications.getWithChecks(latest.id)!;
    if (run.status !== 'passed') throw new VerificationBlockedError(run.summary ?? 'This code has not passed its checks, so it cannot run.');
    const version = this.deps.versions.getByIdWithFiles(run.codeVersionId)!;
    const intent = this.assemble(execution.taskId, executionId, version, run);
    return { intent, intentDigest: buildIntentDigest(intent), run, version };
  }

  private assemble(taskId: number, executionId: number, version: CodeVersionWithFiles, run: VerificationRunWithChecks): RunIntent {
    const tests = detailOf(run, 'tests');
    const runtime = JSON.parse(run.runtimeDetail) as RuntimeDetail;
    return {
      executionId,
      codeVersion: { id: version.id, shortDigest: shortDigest(run.contentDigest), contentDigest: run.contentDigest, fileCount: version.files.length, lineCount: version.files.reduce((sum, { content }) => sum + countLines(content), 0), entrypoint: version.entrypoint },
      verificationRunId: run.id,
      summary: version.summary,
      inputs: this.inputs(taskId),
      outputs: this.outputs(version),
      checks: run.checks.map(({ checkKey, status, isBlocking, summary }) => ({ checkKey: checkKey as CheckKey, status: status as CheckStatus, isBlocking, summary })),
      verdict: run.summary ?? '',
      blockingCount: run.blockingCount,
      advisoryCount: run.advisoryCount,
      tests: { total: count(tests.total), passed: count(tests.passed), fixtureRowCount: count(tests.fixtureRowCount) },
      runtime: { fingerprint: run.runtimeFingerprint, description: describeRuntime(runtime), packages: runtime.packages.map(({ name, version: packageVersion }) => ({ name, version: packageVersion })) },
      caveats: [...RUN_INTENT_CAVEATS],
    };
  }

  /** What will be read: the person's own files, by display name, size, and short digest. */
  private inputs(taskId: number): RunIntent['inputs'] {
    return this.deps.uploads.listByTask(taskId).map((upload) => ({
      uploadId: upload.id,
      originalFilename: upload.originalFilename,
      byteSize: upload.byteSize,
      shortSha256: shortDigest(upload.sha256),
      sheets: this.deps.profiles.listByUpload(upload.id).flatMap(({ sheetName }) => (sheetName === null ? [] : [sheetName])),
    }));
  }

  /** What the script says it will write, exactly as declared (validated by the outputs check). */
  private outputs(version: CodeVersionWithFiles): RunIntent['outputs'] {
    const parsed = parseOutputManifest(JSON.stringify({ artifacts: safeArray(version.declaredOutputs) }));
    return (parsed?.artifacts ?? []).map(({ filename, type, title, description }) => ({ filename, type, title, description }));
  }
}

function safeArray(text: string | null): unknown[] {
  try { const value: unknown = text ? JSON.parse(text) : []; return Array.isArray(value) ? value : []; } catch { return []; }
}
