// FEAT-108 TASK-013: opt-in proof against real uv, real Python, and the real
// platform process tree. Skipped unless AUTOMATE_LIVE_PYTHON=1; the CI workflow
// `.github/workflows/live-python-runtime.yml` runs it on Windows, macOS, and
// Linux. Every scenario asserts on stored rows, files on disk, or process
// liveness — never on a service's return value alone — so an implementation
// that reports success while doing nothing fails.
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PythonRunner } from '@automate/core';
import { PINNED_PYTHON_VERSION, SCRIPT_DEPENDENCY_SET } from '../execution/dependency-policy';
import { FakePythonRunner } from '../execution/testing/fake-python-runner';
import { RuntimeEnvironmentRepository } from '../db/repositories/runtime-environment-repository';
import { RuntimeProvisioner } from '../execution/runtime-provisioner';
import { UvPythonRunner, type UvPythonRunnerOptions } from '../execution/uv-python-runner';
import { createTempStore, type TempStore } from './support/ingestion-fixtures';
import { createVerificationHarness, type VerificationHarness } from './support/verification-harness';

const RUNTIME_SOURCE = fileURLToPath(new URL('../../runtime', import.meta.url));
/** Distribution name → import name, where they differ. */
const IMPORT_NAMES: Record<string, string> = { 'python-dateutil': 'dateutil' };
const LIVE = process.env.AUTOMATE_LIVE_PYTHON === '1';
const MINUTES = 60_000;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return predicate();
}

// Every script starts with `SOURCE = "INPUT"`: the scripted agent replaces the
// first literal INPUT with the staged upload's stored filename.
const PREAMBLE = ['SOURCE = "INPUT"', 'import json, os, sys, time', 'from pathlib import Path', 'OUT = Path(os.environ["AUTOMATE_OUTPUT_DIR"])', 'IN = Path(os.environ["AUTOMATE_INPUT_DIR"])'];
const script = (...lines: string[]) => [...PREAMBLE, ...lines, ''].join('\n');
const PIDFILE = '(OUT / "script.pid").write_text(str(os.getpid()))';
const SCRIPTS = {
  report: script(
    'import pandas as pd', 'import matplotlib', 'matplotlib.use("Agg")', 'import matplotlib.pyplot as plt',
    'frame = pd.read_csv(IN / SOURCE)',
    'frame.groupby("region")["amount"].sum().to_csv(OUT / "totals.csv")',
    'plt.plot([1, 2], [2, 3])', 'plt.savefig(OUT / "plot.png")',
    'json.dump({"artifacts": [{"filename": "totals.csv", "type": "csv", "title": "Totals", "description": ""}, {"filename": "plot.png", "type": "image", "title": "Plot", "description": ""}]}, open(OUT / "manifest.json", "w"))',
  ),
  sleep: script(PIDFILE, 'time.sleep(60)'),
  flood: script('with open(OUT / "large.bin", "wb") as f:', '    f.write(b"x" * 1048576)', '    f.flush()', '    time.sleep(30)'),
  memory: script('block = bytearray(1024 * 1024 * 1024)'),
  grandchild: script(
    'import subprocess',
    'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])',
    '(OUT / "child.pid").write_text(str(child.pid))', PIDFILE, 'time.sleep(120)',
  ),
} as const;

/**
 * The full gate over a temporary data root: scripted generation and fake
 * checkers reach `awaiting_approval`, and the approved run goes through a real
 * `UvPythonRunner` against a really prepared environment.
 */
async function liveGate(code: string, runner: Partial<UvPythonRunnerOptions> = {}, scriptRunTimeoutMs?: number) {
  let provisioner!: RuntimeProvisioner;
  const proxy = {
    ensureRuntime: (kind: 'script' | 'verify', signal: AbortSignal) => provisioner.ensureRuntime(kind, signal),
    getReadiness: (kind: 'script' | 'verify') => provisioner.getReadiness(kind),
    getLauncherDigest: () => provisioner.getLauncherDigest(),
  };
  const h = await createVerificationHarness({
    script: code, provisioner: proxy, onApproved: () => undefined, ...(scriptRunTimeoutMs ? { scriptRunTimeoutMs } : {}),
    runner: (paths, connection): PythonRunner => {
      provisioner = new RuntimeProvisioner({ scriptEnvDir: paths.envDir, verifyEnvDir: paths.verifyEnvDir, environments: new RuntimeEnvironmentRepository(connection) });
      const real = new UvPythonRunner({ envDir: paths.envDir, provisioner, ...runner });
      const fake = new FakePythonRunner();
      let runs = 0;
      // Generation's and verification's pytest runs are scripted; the third run is the real one.
      return { probe: () => fake.probe(), ensureEnvironment: (signal) => fake.ensureEnvironment(signal), run: (request) => { runs += 1; return runs < 3 ? fake.run(request) : real.run(request); } };
    },
  });
  cleanups.push(() => h.dispose());
  expect((await h.runToGate()).status).toBe('awaiting_approval');
  await h.approve();
  const output = path.join(h.store.paths.runsDir, String(h.execution.id), 'output');
  const stored = () => ({ run: h.repos.scriptRuns.getByExecution(h.execution.id), execution: h.repos.executions.getById(h.execution.id) });
  return { h, output, stored };
}
async function runToSettle(h: VerificationHarness): Promise<void> {
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
}

describe.skipIf(!LIVE)('live Python runtime', () => {
  it('cold-provisions both environments, pins the interpreter, and keeps the fingerprint stable', async () => {
    const store: TempStore = createTempStore('automate-live-runtime-');
    cleanups.push(() => store.dispose());
    const environments = new RuntimeEnvironmentRepository(store.connection);
    const provisioner = new RuntimeProvisioner({ scriptEnvDir: store.paths.envDir, verifyEnvDir: store.paths.verifyEnvDir, environments });
    const signal = new AbortController().signal;

    expect((await provisioner.ensureRuntime('script', signal)).prepared).toBe(true);
    const ready = environments.getReady('script')!;
    expect(ready).toMatchObject({ status: 'ready', pythonVersion: PINNED_PYTHON_VERSION });
    const installed = JSON.parse(ready.packageJson!) as { name: string; version: string }[];
    for (const { name, version } of SCRIPT_DEPENDENCY_SET) expect(installed.find((entry) => entry.name.toLowerCase() === name)?.version).toBe(version);
    expect(existsSync(path.join(store.paths.envDir, 'automate_launch.py'))).toBe(true);

    expect((await provisioner.ensureRuntime('script', signal)).prepared).toBe(false);
    expect(environments.getReady('script')!.fingerprint).toBe(ready.fingerprint);
    expect(environments.getReady('script')!.id).toBe(ready.id);
    await provisioner.ensureRuntime('verify', signal);
    expect(environments.getReady('verify')).toMatchObject({ status: 'ready', pythonVersion: PINNED_PYTHON_VERSION });

    // Every declared package imports under the pinned interpreter, through the launcher.
    const work = mkdtempSync(path.join(os.tmpdir(), 'automate-live-imports-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const imports = SCRIPT_DEPENDENCY_SET.map(({ name }) => IMPORT_NAMES[name] ?? name);
    appendFileSync(path.join(work, 'imports.py'), `import sys\n${imports.map((name) => `import ${name}`).join('\n')}\nprint(sys.version.split()[0])\n`);
    const runner = new UvPythonRunner({ envDir: store.paths.envDir, provisioner });
    const result = await runner.run({ executionId: 1, workingDir: work, args: ['imports.py'], env: { AUTOMATE_OUTPUT_DIR: work }, timeoutMs: 2 * MINUTES, signal });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(PINNED_PYTHON_VERSION);
  }, 20 * MINUTES);

  it('detects drift: a tampered installed lock re-prepares in place; a changed committed lock records a new environment', async () => {
    const store: TempStore = createTempStore('automate-live-drift-');
    cleanups.push(() => store.dispose());
    const environments = new RuntimeEnvironmentRepository(store.connection);
    const signal = new AbortController().signal;
    const provisioner = new RuntimeProvisioner({ scriptEnvDir: store.paths.envDir, verifyEnvDir: store.paths.verifyEnvDir, environments });
    const first = (await provisioner.ensureRuntime('script', signal)).row;

    // The installed copy is not the source of truth: it is re-copied from the committed lock,
    // so the scope — and therefore the row — is unchanged.
    appendFileSync(path.join(store.paths.envDir, 'uv.lock'), '\n# drift\n');
    const repaired = await provisioner.ensureRuntime('script', signal);
    expect(repaired.prepared).toBe(true);
    expect(environments.getReady('script')).toMatchObject({ id: first.id, lockDigest: first.lockDigest });
    expect(readFileSync(path.join(store.paths.envDir, 'uv.lock'), 'utf8')).not.toContain('# drift');

    // A changed committed lock is a different environment: a second row, the first kept.
    const source = mkdtempSync(path.join(os.tmpdir(), 'automate-live-source-'));
    cleanups.push(() => rmSync(source, { recursive: true, force: true }));
    cpSync(RUNTIME_SOURCE, source, { recursive: true });
    appendFileSync(path.join(source, 'script-env', 'uv.lock'), '\n# a regenerated lock\n');
    const moved = new RuntimeProvisioner({ scriptEnvDir: store.paths.envDir, verifyEnvDir: store.paths.verifyEnvDir, environments, sourceDir: source });
    expect((await moved.ensureRuntime('script', signal)).prepared).toBe(true);
    const second = environments.getReady('script')!;
    expect(second.id).not.toBe(first.id);
    expect(second.lockDigest).not.toBe(first.lockDigest);
    const rows = store.connection.client.prepare("SELECT id, lock_digest FROM runtime_environment WHERE kind = 'script' ORDER BY id").all() as { id: number; lock_digest: string }[];
    expect(rows.map(({ id }) => id)).toEqual([first.id, second.id]);
  }, 20 * MINUTES);

  it('runs an approved CSV-to-CSV-and-PNG script and parks it for review', async () => {
    const { h, output, stored } = await liveGate(SCRIPTS.report);
    await runToSettle(h);
    const { run, execution } = stored();
    expect(run, run?.stderr ?? '').toMatchObject({ status: 'succeeded', exitCode: 0, declaredOutputCount: 2, producedOutputCount: 2, limitBreached: null });
    expect(run?.runtimeLockDigest).toBe(new RuntimeEnvironmentRepository(h.store.connection).getReady('script')?.lockDigest);
    expect(run?.outputByteCount).toBeGreaterThan(100);
    expect(execution?.status).toBe('awaiting_review');
    expect(readFileSync(path.join(output, 'totals.csv'), 'utf8')).toMatch(/region/);
    // The PNG is the assertion that matplotlib earns its place in the set.
    expect(readFileSync(path.join(output, 'plot.png')).subarray(1, 4).toString('ascii')).toBe('PNG');
  }, 20 * MINUTES);

  it('stops a script that outruns its clock and kills its process', async () => {
    const { h, output, stored } = await liveGate(SCRIPTS.sleep, {}, 5_000);
    await runToSettle(h);
    expect(stored()).toMatchObject({ run: { status: 'timed_out', limitBreached: 'time' }, execution: { status: 'failed' } });
    const pid = Number(readFileSync(path.join(output, 'script.pid'), 'utf8'));
    expect(await until(() => !alive(pid))).toBe(true);
  }, 20 * MINUTES);

  it('stops a script whose output passes the byte cap', async () => {
    const { h, stored } = await liveGate(SCRIPTS.flood, { maxOutputTotalBytes: 1024, outputWatchIntervalMs: 100 });
    await runToSettle(h);
    expect(stored()).toMatchObject({ run: { status: 'failed', limitBreached: 'output_bytes' }, execution: { status: 'failed', errorCode: 'SCRIPT_LIMIT_EXCEEDED' } });
    expect(stored().run?.durationMs).toBeLessThan(25_000);
  }, 20 * MINUTES);

  it.skipIf(process.platform === 'win32')('enforces the POSIX memory limit through the launcher', async () => {
    const { h, stored } = await liveGate(SCRIPTS.memory, { memoryLimitBytes: 536_870_912 });
    await runToSettle(h);
    expect(stored()).toMatchObject({ run: { status: 'failed', exitCode: 93, limitBreached: 'memory' }, execution: { status: 'failed', errorCode: 'SCRIPT_LIMIT_EXCEEDED' } });
  }, 20 * MINUTES);

  it('an abort kills the script and the child it spawned', async () => {
    const { h, output, stored } = await liveGate(SCRIPTS.grandchild);
    h.scriptRun.start(h.execution.id);
    const pids = [path.join(output, 'script.pid'), path.join(output, 'child.pid')];
    expect(await until(() => pids.every((file) => existsSync(file)), 5 * MINUTES)).toBe(true);
    const [scriptPid, childPid] = pids.map((file) => Number(readFileSync(file, 'utf8'))) as [number, number];
    expect(alive(scriptPid) && alive(childPid)).toBe(true);
    await h.registry.abort(h.execution.id);
    expect(stored()).toMatchObject({ run: { status: 'aborted', limitBreached: null }, execution: { status: 'aborted' } });
    expect(await until(() => !alive(scriptPid) && !alive(childPid))).toBe(true);
  }, 20 * MINUTES);
});
