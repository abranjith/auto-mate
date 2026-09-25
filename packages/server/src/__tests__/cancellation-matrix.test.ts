// FEAT-108 TASK-010: plan §6's cancellation requirement as ONE table. Every leg
// this project has accumulated — provider generation (FEAT-102), a clarification
// wait (FEAT-105), dependency sync and generated tests (FEAT-106), verification
// and both parked gates (FEAT-107), interpreter install, runtime sync, and the
// real run (FEAT-108) — is cancelled through the one existing abort path, with
// the same assertions repeated: the execution settles `aborted`, the leg's own
// row settles `aborted` with its settlement time, no process this application
// started is still alive, concurrent aborts are idempotent, and a further abort
// of the now-terminal execution is refused.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionNotRunningError, type ConversationEvent, type PythonRunner } from '@automate/core';
import { RuntimeEnvironmentRepository } from '../db/repositories/runtime-environment-repository';
import { ProcessRunner } from '../execution/process-runner';
import { RuntimeProvisioner } from '../execution/runtime-provisioner';
import { UvPythonRunner } from '../execution/uv-python-runner';
import { FakePythonRunner, type FakePythonRun } from '../execution/testing/fake-python-runner';
import { fakeSpawn, type FakeBehavior } from './execution/fake-spawn';
import { createGenerationHarness, writeSteps, type GenerationHarness, type HarnessOptions } from './support/generation-harness';
import { INSPECT_OUTPUT, lockedUvRunner } from './support/locked-uv-runner';
import { createVerificationHarness, type VerificationHarness, type VerificationHarnessOptions } from './support/verification-harness';

const disposables: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(disposables.splice(0).map((h) => h.dispose()));
});

type Fake = ReturnType<typeof fakeSpawn>;
/** What every leg's harness offers — generation-only and full-gate harnesses alike. */
type Harness = Pick<GenerationHarness, 'registry' | 'execution' | 'transcript' | 'store'> & { readonly repos: Pick<GenerationHarness['repos'], 'executions'> };
/** The leg's own row, reduced to what every leg is asserted on. */
type LegRow = { readonly status: string; readonly settledAt: Date | null } | undefined;
interface Leg {
  readonly h: Harness;
  /** Fake processes the leg started; absent for legs that start none. */
  readonly fake?: Fake;
  /** The leg's own row; absent for legs that own none (provider generation, the two gates). */
  readonly row?: () => LegRow;
  /** Resolves once a generation session has settled; phase jobs settle inside `abort`. */
  readonly settled?: Promise<unknown>;
  /** Leg-specific evidence beyond the shared assertions. */
  readonly extra?: () => void;
}

const hang = () => new Promise<void>(() => undefined);
const RUN_TESTS = { call: { tool: 'run_tests', args: {} } } as const;
const UV = { stdout: 'uv 0.11.32\n' } as const;
const CLARIFY = { call: { tool: 'request_clarification', args: { questions: [{ question: 'Which total?', rationale: 'It changes the meaning.', impact: 'meaning', proposedDefault: 'sum' }] } } } as const;
const producing: FakePythonRun = { onRun: (request) => { writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'totals.csv'), 'a\n'); writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), JSON.stringify({ artifacts: [{ filename: 'totals.csv', type: 'csv', title: 'T', description: '' }] })); } };
const count = (h: Harness, table: string) => (h.store.connection.client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const aborts = (h: Harness) => h.transcript().filter((event: ConversationEvent) => event.type === 'state_changed' && event.to === 'aborted');
const environment = (h: Harness): LegRow => { const row = new RuntimeEnvironmentRepository(h.store.connection).getLatest('script'); return row && { status: row.status, settledAt: row.preparedAt }; };

async function until(predicate: () => boolean): Promise<void> {
  for (let spin = 0; spin < 600 && !predicate(); spin += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
async function generation(options: HarnessOptions) {
  const h = await createGenerationHarness(options);
  disposables.push(h);
  return h;
}
async function gated(options: VerificationHarnessOptions = {}) {
  const h = await createVerificationHarness({ onApproved: () => undefined, ...options });
  disposables.push(h);
  return h;
}
/** A provisioner resolved lazily, so it can be built over a harness's own data root. */
function lazyProvisioner() {
  const ref: { current?: RuntimeProvisioner } = {};
  const proxy = {
    ensureRuntime: (kind: 'script' | 'verify', signal: AbortSignal) => ref.current!.ensureRuntime(kind, signal),
    getReadiness: (kind: 'script' | 'verify') => ref.current!.getReadiness(kind),
    getLauncherDigest: () => ref.current!.getLauncherDigest(),
  };
  return { ref, proxy };
}
function provisionerOver(h: Harness, fake: Fake): RuntimeProvisioner {
  return new RuntimeProvisioner({ scriptEnvDir: h.store.paths.envDir, verifyEnvDir: h.store.paths.verifyEnvDir, environments: new RuntimeEnvironmentRepository(h.store.connection), processes: new ProcessRunner({ spawn: fake.spawn, platform: 'win32' }), platform: 'win32' });
}

// ---- legs ------------------------------------------------------------------

async function providerGeneration(): Promise<Leg> {
  const h = await generation({ steps: () => [{ until: hang() }] });
  const settled = h.run();
  await until(() => h.provider.sessions.length === 1 && h.repos.executions.getById(h.execution.id)?.status === 'generating');
  return { h, settled, extra: () => expect(h.provider.sessions[0]!.abortCount).toBe(1) };
}

async function clarificationWait(): Promise<Leg> {
  const h = await generation({ steps: () => [CLARIFY] });
  const settled = h.run();
  await until(() => h.repos.executions.getById(h.execution.id)?.status === 'waiting');
  const row = () => h.repos.clarifications.listByExecution(h.execution.id)[0];
  return { h, settled, row: () => { const batch = row(); return batch && { status: batch.status === 'cancelled' ? 'aborted' : batch.status, settledAt: batch.settledAt }; } };
}

async function generationLeg(target: 'sync' | 'pytest'): Promise<Leg> {
  let fake!: Fake;
  const behave = (_: string, args: readonly string[]): FakeBehavior => {
    if (args[0] === '--version') return UV;
    if (target === 'sync' && args[0] === 'sync') return { hang: true };
    if (target === 'pytest' && args.includes('pytest')) return { hang: true };
    return {};
  };
  const h = await generation({ runner: (paths, connection) => { const built = lockedUvRunner(paths, connection, behave); fake = built.fake; return built.runner; }, steps: (upload) => [...writeSteps(upload!.storedFilename), RUN_TESTS] });
  const settled = h.run();
  await until(() => fake.calls.some(({ args }) => (target === 'sync' ? args[0] === 'sync' : args.includes('pytest'))));
  if (target === 'sync') return { h, fake, settled, row: () => environment(h), extra: () => expect(fake.calls.some(({ args }) => args.includes('pytest'))).toBe(false) };
  const attempt = () => h.repos.attempts.listByExecution(h.execution.id)[0];
  return { h, fake, settled, row: () => { const row = attempt(); return row && { status: row.status, settledAt: row.settledAt }; } };
}

async function verification(): Promise<Leg> {
  let entered = false;
  const h = await gated({ checkers: (tool) => { if (tool === 'ruff') entered = true; return tool === 'ruff' ? { waitUntil: hang() } : {}; } });
  void h.run();
  await until(() => entered);
  return { h, row: () => { const pass = h.repos.verifications.getLatest(h.execution.id); return pass && { status: pass.status, settledAt: pass.settledAt }; } };
}

async function approvalGate(): Promise<Leg> {
  const h = await gated();
  await h.runToGate();
  const spawned = (h.runner as FakePythonRunner).requests.length;
  return { h, extra: () => { expect(count(h, 'execution_approval')).toBe(0); expect(count(h, 'script_run')).toBe(0); expect((h.runner as FakePythonRunner).requests).toHaveLength(spawned); } };
}

async function reviewGate(): Promise<Leg> {
  const h = await gated({ pythonRuns: [{}, {}, producing] });
  await h.runToGate();
  await h.approve();
  await h.scriptRun.run(h.execution.id, new AbortController().signal);
  return { h, extra: () => { expect(h.repos.scriptRuns.getByExecution(h.execution.id)?.status).toBe('succeeded'); expect(h.repos.executions.listByTask(h.task.id)).toHaveLength(1); } };
}

/** Approve, start the run leg, and wait until the runtime's `target` step is hanging. */
async function runtimePreparation(target: 'install' | 'sync'): Promise<Leg> {
  const { ref, proxy } = lazyProvisioner();
  const h = await gated({ provisioner: proxy });
  const fake = fakeSpawn((_, args) => {
    if (args[0] === '--version') return UV;
    if (args[0] === 'python' && args[1] === 'find') return { exitCode: target === 'install' ? 1 : 0 };
    if (args[0] === 'python' && args[1] === 'install') return { hang: true };
    if (args[0] === 'sync') return { hang: true };
    return {};
  });
  ref.current = provisionerOver(h, fake);
  await h.runToGate();
  await h.approve();
  h.scriptRun.start(h.execution.id);
  await until(() => fake.calls.some(({ args }) => (target === 'install' ? args[1] === 'install' : args[0] === 'sync')));
  return { h, fake, row: () => environment(h), extra: () => { expect(h.repos.scriptRuns.getByExecution(h.execution.id)).toBeUndefined(); expect(environment(h)?.status).toBe('aborted'); } };
}

/** The real run: a locked `UvPythonRunner` over fake processes, hanging in the launcher. */
async function realRun(): Promise<Leg> {
  const { ref, proxy } = lazyProvisioner();
  const fake = fakeSpawn((_, args) => {
    if (args[0] === '--version') return UV;
    if (args[0] === 'run' && args.includes('-c')) return { stdout: INSPECT_OUTPUT };
    if (args.some((arg) => arg.endsWith('automate_launch.py'))) return { hang: true };
    return {};
  });
  const h = await gated({ provisioner: proxy, runner: (paths): PythonRunner => {
    const fakeRunner = new FakePythonRunner();
    const real = () => new UvPythonRunner({ envDir: paths.envDir, provisioner: ref.current!, processes: new ProcessRunner({ spawn: fake.spawn, platform: 'win32' }), platform: 'win32', baseEnv: {} });
    let runs = 0;
    return { probe: () => fakeRunner.probe(), ensureEnvironment: (signal) => fakeRunner.ensureEnvironment(signal), run: (request) => { runs += 1; return runs < 3 ? fakeRunner.run(request) : real().run(request); } };
  } });
  ref.current = provisionerOver(h, fake);
  mkdirSync(path.join(h.store.paths.envDir, '.venv'), { recursive: true });
  await h.runToGate();
  await h.approve();
  h.scriptRun.start(h.execution.id);
  await until(() => fake.calls.some(({ args }) => args.some((arg) => arg.endsWith('automate_launch.py'))));
  return { h, fake, row: () => { const run = h.repos.scriptRuns.getByExecution(h.execution.id); return run && { status: run.status, settledAt: run.settledAt }; }, extra: () => expect(h.repos.scriptRuns.getByExecution(h.execution.id)?.limitBreached).toBeNull() };
}

const LEGS = [
  ['provider generation (FEAT-102)', providerGeneration],
  ['a clarification wait (FEAT-105)', clarificationWait],
  ['dependency sync during generation (FEAT-106)', () => generationLeg('sync')],
  ['generated tests (FEAT-106)', () => generationLeg('pytest')],
  ['verification checks (FEAT-107)', verification],
  ['the approval gate (FEAT-107)', approvalGate],
  ['the review gate (FEAT-107)', reviewGate],
  ['interpreter install (FEAT-108)', () => runtimePreparation('install')],
  ['runtime environment sync (FEAT-108)', () => runtimePreparation('sync')],
  ['the real run (FEAT-108)', realRun],
] as const;

describe('cancellation matrix', () => {
  it.each(LEGS)('aborting %s settles every row and leaves no process alive', async (_leg, setup) => {
    const { h, fake, row, settled, extra } = await setup();
    const hung = fake?.live() ?? [];
    const results = await Promise.allSettled([h.registry.abort(h.execution.id), h.registry.abort(h.execution.id)]);
    await settled;
    expect(results.some(({ status }) => status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'fulfilled') expect(result.value.status).toBe('aborted');
      else expect(result.reason).toBeInstanceOf(ExecutionNotRunningError);
    }
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('aborted');
    expect(aborts(h)).toHaveLength(1);
    if (row) {
      expect(row()?.status).toBe('aborted');
      expect(row()?.settledAt).toBeInstanceOf(Date);
    }
    if (fake) {
      expect(hung.length).toBeGreaterThan(0);
      expect(fake.live()).toEqual([]);
      for (const pid of hung) expect(fake.calls.some(({ command, args }) => command === 'taskkill' && args.join(' ') === `/pid ${pid} /T /F`)).toBe(true);
    }
    extra?.();
    await expect(h.registry.abort(h.execution.id)).rejects.toBeInstanceOf(ExecutionNotRunningError);
  });
});

describe('cancellation matrix: shared preparation, limits, and drain', () => {
  it('an abort detaches from a preparation another execution is still waiting on', async () => {
    let release!: () => void;
    const synced = new Promise<void>((resolve) => { release = resolve; });
    const { ref, proxy } = lazyProvisioner();
    const fake = fakeSpawn((_, args) => {
      if (args[0] === '--version') return UV;
      if (args[0] === 'sync') return { until: synced };
      if (args[0] === 'run' && args.includes('-c')) return { stdout: INSPECT_OUTPUT };
      return {};
    });
    const leaving = await gated({ provisioner: proxy, pythonRuns: [{}, {}, producing] });
    const staying = await gated({ provisioner: proxy, pythonRuns: [{}, {}, producing] });
    // One provisioner for the process, as in the server; its environment lives in `staying`'s root.
    ref.current = provisionerOver(staying, fake);
    for (const h of [leaving, staying]) { await h.runToGate(); await h.approve(); }
    leaving.scriptRun.start(leaving.execution.id);
    staying.scriptRun.start(staying.execution.id);
    await until(() => fake.calls.some(({ args }) => args[0] === 'sync'));

    expect((await leaving.registry.abort(leaving.execution.id)).status).toBe('aborted');
    expect(leaving.repos.scriptRuns.getByExecution(leaving.execution.id)).toBeUndefined();
    expect(environment(staying)?.status).toBe('preparing');
    expect(fake.calls.some(({ command }) => command === 'taskkill')).toBe(false);
    expect(fake.live()).toHaveLength(1);
    expect(staying.repos.executions.getById(staying.execution.id)?.status).toBe('executing');

    mkdirSync(path.join(staying.store.paths.envDir, '.venv'), { recursive: true });
    release();
    await staying.settledPhases(staying.execution.id);
    expect(environment(staying)?.status).toBe('ready');
    expect(staying.repos.executions.getById(staying.execution.id)?.status).toBe('awaiting_review');
    expect(staying.repos.scriptRuns.getByExecution(staying.execution.id)?.status).toBe('succeeded');
    expect(fake.calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(1);
    expect(leaving.repos.executions.getById(leaving.execution.id)?.status).toBe('aborted');
  });

  it('the last waiter to abort cancels the shared preparation', async () => {
    const leg = await runtimePreparation('sync');
    await leg.h.registry.abort(leg.h.execution.id);
    expect(environment(leg.h)?.status).toBe('aborted');
    expect(leg.fake!.live()).toEqual([]);
  });

  it('a limit-driven kill and a user abort are distinguishable in storage', async () => {
    const timed = await gated({ pythonRuns: [{}, {}, { result: { outcome: 'timed_out', exitCode: null } }] });
    const memory = await gated({ pythonRuns: [{}, {}, { result: { outcome: 'failed', exitCode: 93, stderr: 'memory limit' } }] });
    const cancelled = await gated({ pythonRuns: [{}, {}, { waitUntil: hang() }] });
    for (const h of [timed, memory]) { await h.runToGate(); await h.approve(); await h.scriptRun.run(h.execution.id, new AbortController().signal); }
    await cancelled.runToGate();
    await cancelled.approve();
    cancelled.scriptRun.start(cancelled.execution.id);
    await until(() => (cancelled.runner as FakePythonRunner).requests.length === 3);
    await cancelled.registry.abort(cancelled.execution.id);
    const stored = (h: VerificationHarness) => ({ run: h.repos.scriptRuns.getByExecution(h.execution.id), execution: h.repos.executions.getById(h.execution.id) });
    expect(stored(timed)).toMatchObject({ run: { status: 'timed_out', limitBreached: 'time' }, execution: { status: 'failed' } });
    expect(stored(memory)).toMatchObject({ run: { status: 'failed', limitBreached: 'memory' }, execution: { status: 'failed', errorCode: 'SCRIPT_LIMIT_EXCEEDED' } });
    expect(stored(cancelled)).toMatchObject({ run: { status: 'aborted', limitBreached: null }, execution: { status: 'aborted', errorCode: null } });
  });

  it('drain stops an in-flight interpreter install and leaves no process alive', async () => {
    const { h, fake } = await runtimePreparation('install');
    await h.registry.drain(1_000);
    expect(environment(h)?.status).toBe('aborted');
    expect(fake!.live()).toEqual([]);
    expect(['aborted', 'failed']).toContain(h.repos.executions.getById(h.execution.id)?.status);
  });

  it('drain marks a leg that does not settle within the timeout interrupted', async () => {
    const h = await gated();
    await h.runToGate();
    h.repos.executions.transitionStatus(h.execution.id, 'executing');
    let aborted = 0;
    h.registry.track(h.execution.id, { abort: () => { aborted += 1; }, settled: hang() });
    await h.registry.drain(50);
    expect(aborted).toBe(1);
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('failed');
    expect(h.transcript().at(-1)).toMatchObject({ type: 'state_changed', from: 'executing', to: 'failed' });
  });
});
