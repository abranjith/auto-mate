import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRuntimeFingerprint, normalizeRuntimeDetail, PYTHON_INSTALL_TIMEOUT_MS, RUNTIME_PREPARE_TIMEOUT_MS, PythonRuntimeUnavailableError, RuntimeLockMismatchError, RuntimePrepareFailedError, type RuntimeKind, type RuntimeReadiness } from '@automate/core';
import { resolveWithin } from '../config/app-paths';
import { uvInstallHint } from '../preflight/doctor';
import { RuntimeEnvironmentRepository, type RuntimeEnvironmentRow, type RuntimeScope } from '../db/repositories/runtime-environment-repository';
import { LOCKED_COMMANDS, PINNED_PYTHON_VERSION, uvCommand } from './dependency-policy';
import { deployLauncher, verifyLauncher } from './launcher-deploy';
import { ProcessRunner, type ProcessResult } from './process-runner';

const RUNTIME_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runtime');
const INSPECT_SCRIPT = 'import importlib.metadata as m, json, sys; print(json.dumps({"python": "%d.%d.%d" % sys.version_info[:3], "packages": sorted([[d.metadata["Name"], d.version] for d in m.distributions() if d.metadata["Name"]])}))';
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const names = ['pyproject.toml', 'uv.lock', '.python-version'] as const;

export interface RuntimeProvisionerOptions {
  readonly scriptEnvDir: string;
  readonly verifyEnvDir: string;
  readonly environments: RuntimeEnvironmentRepository;
  readonly processes?: ProcessRunner;
  readonly sourceDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly prepareTimeoutMs?: number;
  readonly pythonInstallTimeoutMs?: number;
}

/** Prepares committed uv projects once per kind and stores their exact runtime facts. */
export class RuntimeProvisioner {
  private readonly processes: ProcessRunner;
  private readonly inFlight = new Map<RuntimeKind, { controller: AbortController; promise: Promise<{ row: RuntimeEnvironmentRow; prepared: boolean }>; waiters: number }>();

  constructor(private readonly options: RuntimeProvisionerOptions) {
    this.processes = options.processes ?? new ProcessRunner({ platform: options.platform });
  }

  /** Return the ready row, preparing only when manifests, venv, or stored scope differ. */
  ensureRuntime(kind: RuntimeKind, signal: AbortSignal): Promise<{ row: RuntimeEnvironmentRow; prepared: boolean }> {
    if (signal.aborted) return Promise.reject(new RuntimePrepareFailedError('cancelled preparation'));
    let shared = this.inFlight.get(kind);
    if (!shared) {
      const controller = new AbortController();
      shared = { controller, promise: this.prepare(kind, controller.signal).finally(() => this.inFlight.delete(kind)), waiters: 0 };
      this.inFlight.set(kind, shared);
    }
    shared.waiters += 1;
    return this.waitFor(shared, signal);
  }

  private waitFor(shared: NonNullable<ReturnType<typeof this.inFlight.get>>, signal: AbortSignal): Promise<{ row: RuntimeEnvironmentRow; prepared: boolean }> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const settle = () => { if (finished) return false; finished = true; signal.removeEventListener('abort', abort); shared.waiters -= 1; return true; };
      const abort = () => {
        if (!settle()) return;
        const error = new RuntimePrepareFailedError('cancelled preparation');
        if (shared.waiters > 0) { reject(error); return; }
        shared.controller.abort();
        void shared.promise.then(() => reject(error), () => reject(error));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      shared.promise.then((value) => { if (settle()) resolve(value); }, (error: unknown) => { if (settle()) reject(error); });
    });
  }

  /** Read durable readiness and verify the script launcher is still intact. */
  getReadiness(kind: RuntimeKind): RuntimeReadiness {
    const row = this.options.environments.getLatest(kind);
    if (!row) return { ready: false, environment: null, reason: `The ${kind} Python environment is not prepared.` };
    if (row.status !== 'ready') return { ready: false, environment: this.view(row), reason: row.failureReason ?? (row.status === 'preparing' ? 'Preparation is in progress.' : 'Preparation was cancelled.') };
    try {
      const source = path.join(this.options.sourceDir ?? RUNTIME_SOURCE, kind === 'script' ? 'script-env' : 'verify-env');
      if (sha256(readFileSync(path.join(source, 'pyproject.toml'))) !== row.specDigest || sha256(readFileSync(path.join(source, 'uv.lock'))) !== row.lockDigest) throw new Error('manifest drift');
      if (sha256(readFileSync(path.join(this.directory(kind), 'pyproject.toml'))) !== row.specDigest || sha256(readFileSync(path.join(this.directory(kind), 'uv.lock'))) !== row.lockDigest) throw new Error('installed manifest drift');
      if (!existsSync(path.join(this.directory(kind), '.venv'))) throw new Error('environment missing');
      if (kind === 'script') verifyLauncher(this.directory(kind), row.launcherDigest ?? '');
      return { ready: true, environment: this.view(row), reason: null };
    } catch {
      return { ready: false, environment: this.view(row), reason: 'The Python environment files changed. Prepare the environment again.' };
    }
  }

  /** The stored launcher digest used for immediate pre-spawn integrity checking. */
  getLauncherDigest(): string {
    return this.options.environments.getReady('script')?.launcherDigest ?? '';
  }

  /** Probe uv's availability at the point of use. */
  async probeUv(signal: AbortSignal = new AbortController().signal): Promise<string> {
    const result = await this.uv(LOCKED_COMMANDS.probe(), 15_000, signal);
    if (result.spawnError || result.exitCode !== 0) throw new PythonRuntimeUnavailableError('uv', uvInstallHint(this.platform()));
    return result.stdout.trim().split(/\r?\n/)[0] ?? '';
  }

  private async prepare(kind: RuntimeKind, signal: AbortSignal): Promise<{ row: RuntimeEnvironmentRow; prepared: boolean }> {
    const dir = this.directory(kind);
    const source = path.join(this.options.sourceDir ?? RUNTIME_SOURCE, kind === 'script' ? 'script-env' : 'verify-env');
    const sourceFiles = names.map((name) => readFileSync(path.join(source, name)));
    const [spec, lock, pin] = sourceFiles;
    if (pin?.toString().trim() !== PINNED_PYTHON_VERSION) throw new RuntimePrepareFailedError('the interpreter pin');
    const digest = { spec: sha256(spec!), lock: sha256(lock!) };
    const old = this.options.environments.getReady(kind);
    const same = old?.specDigest === digest.spec && old.lockDigest === digest.lock && old.pythonVersion === PINNED_PYTHON_VERSION;
    const copied = names.every((name, index) => existsSync(path.join(dir, name)) && sha256(readFileSync(path.join(dir, name))) === sha256(sourceFiles[index]!));
    if (same && copied && existsSync(path.join(dir, '.venv')) && this.getReadiness(kind).ready) return { row: old, prepared: false };
    const started = performance.now();
    const uvVersion = await this.probeUv(signal);
    const scope: RuntimeScope = { kind, specDigest: digest.spec, lockDigest: digest.lock, pythonVersion: PINNED_PYTHON_VERSION, uvVersion, platform: this.platform(), arch: this.options.arch ?? process.arch };
    const row = this.options.environments.open(scope);
    try {
      mkdirSync(dir, { recursive: true });
      names.forEach((name) => copyFileSync(path.join(source, name), resolveWithin(dir, name)));
      await this.ensurePython(signal);
      const synced = await this.uv(LOCKED_COMMANDS.prepare(dir), this.options.prepareTimeoutMs ?? RUNTIME_PREPARE_TIMEOUT_MS, signal, dir);
      if (synced.aborted) throw new RuntimePrepareFailedError('cancelled preparation');
      if (synced.spawnError || synced.timedOut) throw new RuntimePrepareFailedError('package synchronization');
      if (synced.exitCode !== 0) {
        const detail = `${synced.stderr}\n${synced.stdout}`;
        if (/lockfile needs to be updated|lockfile.*(out.of.date|incompatible)|--locked|resolution.*(lock|fail)/i.test(detail)) throw new RuntimeLockMismatchError();
        throw new RuntimePrepareFailedError('package synchronization');
      }
      const details = await this.inspect(dir, signal);
      const launcher = kind === 'script' ? deployLauncher(dir) : null;
      const fingerprint = computeRuntimeFingerprint(normalizeRuntimeDetail({ pythonVersion: details.python, uvVersion, platform: scope.platform, arch: scope.arch, packages: details.packages }));
      return { row: this.options.environments.settleReady(row.id, { fingerprint, packages: details.packages, launcherDigest: launcher?.digest ?? null, durationMs: Math.round(performance.now() - started) }), prepared: true };
    } catch (cause) {
      if (signal.aborted) this.options.environments.settleAborted(row.id);
      else this.options.environments.settleFailed(row.id, cause instanceof RuntimeLockMismatchError ? cause.message : 'Python environment preparation failed.');
      throw cause;
    }
  }

  private async ensurePython(signal: AbortSignal): Promise<void> {
    const found = await this.uv(LOCKED_COMMANDS.findPython(PINNED_PYTHON_VERSION), 15_000, signal);
    if (found.exitCode === 0) return;
    const installed = await this.uv(LOCKED_COMMANDS.installPython(PINNED_PYTHON_VERSION), this.options.pythonInstallTimeoutMs ?? PYTHON_INSTALL_TIMEOUT_MS, signal);
    if (installed.exitCode !== 0 || installed.spawnError || installed.timedOut) throw new RuntimePrepareFailedError('the pinned interpreter download');
  }

  private async inspect(dir: string, signal: AbortSignal): Promise<{ python: string; packages: { name: string; version: string }[] }> {
    const result = await this.uv(LOCKED_COMMANDS.inspect(dir, INSPECT_SCRIPT), 30_000, signal, dir);
    if (result.exitCode !== 0) throw new RuntimePrepareFailedError('interpreter inspection');
    const parsed = JSON.parse(result.stdout.trim()) as { python: string; packages: [string, string][] };
    if (parsed.python !== PINNED_PYTHON_VERSION) throw new RuntimePrepareFailedError(`interpreter inspection: expected ${PINNED_PYTHON_VERSION} but found ${parsed.python}`);
    return { python: parsed.python, packages: parsed.packages.map(([name, version]) => ({ name, version })) };
  }

  private uv(args: readonly string[], timeoutMs: number, signal: AbortSignal, cwd?: string): Promise<ProcessResult> {
    return this.processes.run({ command: uvCommand(this.platform()), args, timeoutMs, signal, ...(cwd ? { cwd } : {}) });
  }

  private directory(kind: RuntimeKind): string { return kind === 'script' ? this.options.scriptEnvDir : this.options.verifyEnvDir; }
  private platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }

  private view(row: RuntimeEnvironmentRow): NonNullable<RuntimeReadiness['environment']> {
    const packages = row.packageJson ? JSON.parse(row.packageJson) as { name: string; version: string }[] : [];
    return { kind: row.kind as RuntimeKind, status: row.status as NonNullable<RuntimeReadiness['environment']>['status'], pythonVersion: row.pythonVersion, uvVersion: row.uvVersion, fingerprint: row.fingerprint, lockDigest: row.lockDigest.slice(0, 12), packageCount: packages.length, packages, preparedAt: row.preparedAt?.toISOString() ?? null, failureReason: row.failureReason };
  }
}
