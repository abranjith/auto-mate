// ---------------------------------------------------------------------------
// The real-data run (FEAT-107 TASK-011): a MINIMAL run leg through FEAT-106's
// existing `PythonRunner` seam, so `awaiting_review` is reachable. FEAT-108
// replaces the implementation (locked dependency policy, resource limits,
// concurrency, the full cancellation matrix) without widening the seam.
//
// Order: stage verified input copies → recompute the code digest from the
// stored files and re-project them → re-probe the runtime → open the run row
// through `ScriptRunRepository.openGated`, which compares the digest and the
// fingerprint against the stored approval inside its transaction → ONLY THEN
// spawn. A stale approval therefore produces zero processes.
//
// Running and succeeding are different questions: exit 0 with a valid
// manifest and every declared file present settles `awaiting_review`, never
// `completed` — a person decides that.
//
// OUTPUT POLICY: `stdout` and `stderr` may contain values from the person's
// real file. They are stored in the database per memory's logging rule, NEVER
// written to a Pino log, and the only supported route from these columns to a
// model is FEAT-105's `recordDiagnosticTransmission` under the
// `scope_diagnostics` consent. This module calls neither.
//
// Nothing here is a security boundary: the script runs unisolated, with this
// application's access, and can reach files other than its input copy (D03).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AutoMateError,
  ERROR_CODES,
  ExecutionNotApprovedError,
  ExecutionNotFoundError,
  MANIFEST_FILENAME,
  MAX_RUN_OUTPUT_BYTES,
  RunNotFoundError,
  RuntimeNotPreparedError,
  NonPythonEntrypointError,
  SCRIPT_RUN_TIMEOUT_MS,
  computeVersionDigest,
  describeLimitBreach,
  formatDurationMs,
  parseOutputManifest,
  reconcileOutputs,
  shortDigest,
  validateCodePath,
  type LimitBreach,
  type PythonRunResult,
  type PythonRunner,
  type ScriptRun,
} from '@automate/core';
import type { Logger } from 'pino';
import { resolveWithin, type AppPaths } from '../config/app-paths';
import type { CodeVersionRepository, CodeVersionWithFiles } from '../db/repositories/code-version-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { ScriptRunRepository, ScriptRunRow, SettleRun } from '../db/repositories/script-run-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { PhaseJob } from '../conversation/task-session-registry';
import type { ExecutionStateWriter, Publish } from '../verification/execution-state-writer';
import type { RuntimeProbe } from '../verification/runtime-probe';
import { capHeadTail } from './output-cap';
import { stageInputs } from './input-stager';
import { inspectOutput } from './output-watchdog';
import { verifyLauncher } from './launcher-deploy';
import type { RuntimeProvisioner } from './runtime-provisioner';

export interface ScriptRunServiceDependencies {
  readonly executions: ExecutionRepository;
  readonly versions: CodeVersionRepository;
  readonly uploads: UploadRepository;
  readonly scriptRuns: ScriptRunRepository;
  readonly runner: PythonRunner;
  readonly probe: RuntimeProbe;
  readonly provisioner?: Pick<RuntimeProvisioner, 'ensureRuntime' | 'getReadiness' | 'getLauncherDigest'>;
  /** FEAT-106's projection: rewrites a version's files from the database. @returns The absolute attempt directory. */
  readonly project: (versionId: number) => string;
  readonly paths: AppPaths;
  readonly state: ExecutionStateWriter;
  readonly publish: Publish;
  readonly track: (executionId: number, job: PhaseJob) => PhaseJob;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/** The directories one run uses. */
interface RunDirs { readonly root: string; readonly input: string; readonly output: string }

/** How a settled process maps to a run status and, for anything but success, a sentence a non-programmer can act on. */
interface Verdict { readonly status: SettleRun['status']; readonly message: string | null }

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Runs an approved version against a verified copy of the person's file. */
export class ScriptRunService {
  constructor(private readonly deps: ScriptRunServiceDependencies) {}

  /** Start the run in the background, tracked for cancellation and the concurrency cap. */
  start(executionId: number): PhaseJob {
    const controller = new AbortController();
    const settled = this.run(executionId, controller.signal).catch((cause: unknown) => this.onUnexpected(executionId, cause));
    return this.deps.track(executionId, { abort: () => controller.abort(), settled });
  }

  /**
   * Stage, gate, spawn, capture, reconcile, settle.
   * @returns The settled run row, or undefined when the gate refused before a row existed.
   * @throws ExecutionNotApprovedError when the execution is not `executing`.
   */
  async run(executionId: number, signal: AbortSignal): Promise<ScriptRunRow | undefined> {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    if (execution.status !== 'executing') throw new ExecutionNotApprovedError(executionId, execution.status);
    let runtimeLockDigest: string | null = null;
    const dirs = this.dirs(executionId);
    let row: ScriptRunRow;
    let version: CodeVersionWithFiles;
    try {
      if (this.deps.provisioner) {
        const prepared = await this.deps.provisioner.ensureRuntime('script', signal);
        const readiness = this.deps.provisioner.getReadiness('script');
        if (!readiness.ready) throw new RuntimeNotPreparedError('script');
        verifyLauncher(this.deps.paths.envDir, this.deps.provisioner.getLauncherDigest());
        runtimeLockDigest = prepared.row.lockDigest;
        if (prepared.prepared) this.deps.publish(executionId, { type: 'runtime_prepared', kind: 'script', pythonVersion: prepared.row.pythonVersion, packageCount: JSON.parse(prepared.row.packageJson ?? '[]').length as number, at: new Date().toISOString() });
      }
      version = this.deps.versions.getByIdWithFiles(this.deps.versions.findFinal(executionId)!.id)!;
      try { validateCodePath(version.entrypoint, 'script'); }
      catch { throw new NonPythonEntrypointError(); }
      row = await this.openGated(executionId, execution.taskId, version, dirs, signal);
    } catch (cause) {
      this.refuse(executionId, cause, signal);
      return undefined;
    }
    const versionDir = this.deps.project(version.id);
    const result = await this.spawn(executionId, version, versionDir, dirs, signal);
    return this.settle(executionId, row, result, dirs, runtimeLockDigest);
  }

  /** `GET /api/executions/:id/run`. Names outputs by filename only; never a location. */
  describe(executionId: number): ScriptRun {
    const row = this.deps.scriptRuns.getByExecution(executionId);
    if (!row) throw new RunNotFoundError(executionId);
    const manifest = row.manifestJson === null ? null : parseOutputManifest(row.manifestJson);
    const output = resolveWithin(this.deps.paths.root, ...row.dirPath.split('/'), 'output');
    const size = (name: string) => { try { return statSync(resolveWithin(output, name)).size; } catch { return null; } };
    const inputs = (JSON.parse(row.inputManifest) as { uploadId: number; sha256: string; byteSize: number }[]).map(({ uploadId, sha256, byteSize }) => ({ uploadId, byteSize, shortSha256: shortDigest(sha256) }));
    return { id: row.id, executionId: row.executionId, codeVersionId: row.codeVersionId, approvalId: row.approvalId, contentDigest: row.contentDigest, runtimeFingerprint: row.runtimeFingerprint, status: row.status as ScriptRun['status'], exitCode: row.exitCode, stdout: row.stdout, stderr: row.stderr, outputTruncated: row.outputTruncated, manifestPresent: row.manifestPresent, declaredOutputs: (manifest?.artifacts ?? []).map((entry) => { const bytes = size(entry.filename); return { ...entry, byteSize: bytes, present: bytes !== null }; }), declaredOutputCount: row.declaredOutputCount, producedOutputCount: row.producedOutputCount, outputByteCount: row.outputByteCount, limitBreached: row.limitBreached as LimitBreach | null, runtimeLockDigest: row.runtimeLockDigest, inputs, durationMs: row.durationMs, startedAt: row.startedAt.toISOString(), settledAt: row.settledAt?.toISOString() ?? null };
  }

  private dirs(executionId: number): RunDirs {
    const root = resolveWithin(this.deps.paths.runsDir, String(executionId));
    return { root, input: resolveWithin(root, 'input'), output: resolveWithin(root, 'output') };
  }

  /** Stage verified copies, recompute the digest from the stored files, re-probe, and let the database decide. */
  private async openGated(executionId: number, taskId: number, version: CodeVersionWithFiles, dirs: RunDirs, signal: AbortSignal): Promise<ScriptRunRow> {
    const inputs = await stageInputs(this.deps.paths, this.deps.uploads.listByTask(taskId), dirs.input);
    rmSync(dirs.output, { recursive: true, force: true });
    mkdirSync(dirs.output, { recursive: true });
    const contentDigest = computeVersionDigest(version.files.map((file) => ({ path: file.path, sha256: sha(file.content) })));
    const runtime = await this.deps.probe.probe(signal, { fresh: true });
    const row = this.deps.scriptRuns.openGated({ executionId, codeVersionId: version.id, contentDigest, runtimeFingerprint: runtime.fingerprint, dirPath: `runs/${executionId}`, inputs });
    this.deps.logger.info({ executionId, codeVersionId: version.id, digest: shortDigest(contentDigest), fingerprint: shortDigest(runtime.fingerprint), inputCount: inputs.length }, 'script run opened');
    return row;
  }

  private async spawn(executionId: number, version: CodeVersionWithFiles, versionDir: string, dirs: RunDirs, signal: AbortSignal): Promise<PythonRunResult | null> {
    try {
      return await this.deps.runner.run({ executionId, workingDir: versionDir, args: [version.entrypoint], env: { AUTOMATE_INPUT_DIR: dirs.input, AUTOMATE_OUTPUT_DIR: dirs.output }, timeoutMs: this.deps.timeoutMs ?? SCRIPT_RUN_TIMEOUT_MS, signal });
    } catch (cause) {
      this.deps.logger.warn({ executionId, code: cause instanceof AutoMateError ? cause.code : 'SPAWN_FAILED' }, 'script run could not start');
      return null;
    }
  }

  /** Capture, reconcile, record, announce, and move the execution. */
  private settle(executionId: number, row: ScriptRunRow, result: PythonRunResult | null, dirs: RunDirs, runtimeLockDigest: string | null): ScriptRunRow {
    const limit = this.deps.maxOutputBytes ?? MAX_RUN_OUTPUT_BYTES;
    const stdout = capHeadTail(result?.stdout ?? '', limit);
    const stderr = capHeadTail(result?.stderr ?? '', limit);
    const outputs = inspectOutputs(dirs.output);
    const usage = inspectOutput(dirs.output, { maxFileBytes: 0, maxTotalBytes: 0, maxFiles: 0 });
    const verdict = this.verdict(result, outputs);
    const breach = this.breach(result);
    const settled = this.deps.scriptRuns.settle(row.id, { status: verdict.status, exitCode: result?.exitCode ?? null, stdout: result ? stdout.text : null, stderr: result ? stderr.text : null, outputTruncated: stdout.truncated || stderr.truncated || (result?.droppedBytes ?? 0) > 0, manifestPresent: result ? outputs.manifestPresent : null, manifestJson: outputs.manifestJson, declaredOutputCount: outputs.declared, producedOutputCount: result ? outputs.produced : null, outputByteCount: usage.bytes, limitBreached: breach, runtimeLockDigest, durationMs: result?.durationMs ?? Math.max(0, Date.now() - row.startedAt.getTime()) });
    this.deps.publish(executionId, { type: 'run_finished', scriptRunId: settled.id, status: verdict.status, exitCode: settled.exitCode, durationMs: settled.durationMs ?? 0, declaredOutputCount: settled.declaredOutputCount, producedOutputCount: settled.producedOutputCount, outputTruncated: settled.outputTruncated, at: new Date().toISOString() });
    this.deps.logger.info({ executionId, status: verdict.status, exitCode: settled.exitCode, durationMs: settled.durationMs, declared: settled.declaredOutputCount, produced: settled.producedOutputCount }, 'script run settled');
    if (verdict.status === 'succeeded') this.deps.state.move(executionId, 'awaiting_review');
    else if (verdict.status === 'aborted') this.deps.state.settle(executionId, 'aborted');
    else this.deps.state.settle(executionId, 'failed', { code: breach ? ERROR_CODES.SCRIPT_LIMIT_EXCEEDED : ERROR_CODES.RUN_OUTPUT_MISSING, message: breach ? describeLimitBreach(breach) : verdict.message! });
    return settled;
  }

  private verdict(result: PythonRunResult | null, outputs: OutputInspection): Verdict {
    const timeout = this.deps.timeoutMs ?? SCRIPT_RUN_TIMEOUT_MS;
    if (!result) return { status: 'errored', message: 'The script could not be started: uv or Python is not available, or the Python environment is not prepared.' };
    if (result.outcome === 'aborted') return { status: 'aborted', message: null };
    if (result.outcome === 'timed_out') return { status: 'timed_out', message: `The script ran longer than ${formatDurationMs(timeout)} and was stopped. Nothing it produced has been kept as a result.` };
    if (this.breach(result)) return { status: 'failed', message: describeLimitBreach(this.breach(result)!) };
    if (result.exitCode !== 0) return { status: 'failed', message: `The script stopped with an error (exit code ${result.exitCode ?? 'unknown'}) before it finished. Its output is shown below.` };
    if (!outputs.manifestPresent) return { status: 'failed', message: 'The script finished but did not say what it produced.' };
    if (outputs.missing > 0) return { status: 'failed', message: `The script said it would produce ${outputs.declared} file${outputs.declared === 1 ? '' : 's'}, but ${outputs.missing} of them ${outputs.missing === 1 ? 'was' : 'were'} not written.` };
    return { status: 'succeeded', message: null };
  }

  private breach(result: PythonRunResult | null): LimitBreach | null {
    if (!result) return null;
    if (result.outcome === 'timed_out') return 'time';
    if (result.exitCode === 93) return 'memory';
    if (result.exitCode === 94) return 'output_bytes';
    for (const kind of ['memory', 'output_bytes', 'output_files'] as const) if (result.stderr === describeLimitBreach(kind)) return kind;
    return null;
  }

  /** The gate refused before a row existed: settle the execution with the reason and spawn nothing. */
  private refuse(executionId: number, cause: unknown, signal: AbortSignal): void {
    if (signal.aborted) { this.deps.state.settle(executionId, 'aborted'); return; }
    const error = cause instanceof AutoMateError ? { code: cause.code, message: cause.message } : { code: ERROR_CODES.INTERNAL_ERROR, message: 'The run could not be prepared. Start it again to retry.' };
    if (!(cause instanceof AutoMateError)) this.deps.logger.error({ executionId, err: cause }, 'script run could not be prepared');
    else this.deps.logger.warn({ executionId, code: error.code }, 'script run refused before spawning');
    this.deps.state.settle(executionId, 'failed', error, true);
  }

  private onUnexpected(executionId: number, cause: unknown): void {
    this.deps.logger.error({ executionId, code: cause instanceof AutoMateError ? cause.code : 'INTERNAL_ERROR' }, 'script run failed unexpectedly');
    const current = this.deps.state.current(executionId);
    if (current === 'executing') this.deps.state.settle(executionId, 'failed', { code: cause instanceof AutoMateError ? cause.code : ERROR_CODES.INTERNAL_ERROR, message: cause instanceof AutoMateError ? cause.message : 'The run failed because of an unexpected problem. Start it again to retry.' }, true);
  }
}

/** What the output directory holds after a run. The manifest is UNTRUSTED generated-code output. */
interface OutputInspection { readonly manifestPresent: boolean; readonly manifestJson: string | null; readonly declared: number | null; readonly produced: number; readonly missing: number }

function inspectOutputs(outputDir: string): OutputInspection {
  const files = safeList(outputDir);
  let text: string | null;
  try { text = files.includes(MANIFEST_FILENAME) ? readFileSync(path.join(outputDir, MANIFEST_FILENAME), 'utf8') : null; } catch { text = null; }
  const manifest = text === null ? null : parseOutputManifest(text);
  const reconciliation = reconcileOutputs(manifest?.artifacts.map(({ filename }) => filename) ?? [], files);
  return { manifestPresent: manifest !== null, manifestJson: manifest ? text : null, declared: manifest ? reconciliation.declaredCount : null, produced: reconciliation.producedCount, missing: manifest ? reconciliation.missing.length : 0 };
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map(({ name }) => name); } catch { return []; }
}
