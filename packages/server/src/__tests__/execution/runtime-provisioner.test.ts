import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeEnvironmentRepository } from '../../db/repositories/runtime-environment-repository';
import { ProcessRunner } from '../../execution/process-runner';
import { RuntimeProvisioner } from '../../execution/runtime-provisioner';
import { PINNED_PYTHON_VERSION } from '../../execution/dependency-policy';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';
import { fakeSpawn, type FakeBehavior } from './fake-spawn';
import { INSPECT_OUTPUT } from '../support/locked-uv-runner';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

function setup(behavior: (args: readonly string[]) => FakeBehavior = () => ({ exitCode: 0 })) {
  const store = createTempStore('automate-provisioner-');
  stores.push(store);
  const fake = fakeSpawn((_, args) => {
    if (args[0] === 'sync') mkdirSync(path.join(store.paths.envDir, '.venv'), { recursive: true });
    if (args[0] === 'run' && args.includes('-c')) return { stdout: INSPECT_OUTPUT };
    if (args[0] === '--version') return { stdout: 'uv 0.11.32\n' };
    return behavior(args);
  });
  const processes = new ProcessRunner({ spawn: fake.spawn, platform: 'win32' });
  const environments = new RuntimeEnvironmentRepository(store.connection);
  const provisioner = new RuntimeProvisioner({ scriptEnvDir: store.paths.envDir, verifyEnvDir: store.paths.verifyEnvDir, environments, processes, platform: 'win32' });
  return { store, fake, environments, provisioner };
}

describe('RuntimeProvisioner', () => {
  it('copies committed manifests, syncs once, and returns the stored ready row thereafter', async () => {
    const { store, fake, provisioner, environments } = setup();
    const first = await provisioner.ensureRuntime('script', new AbortController().signal);
    expect(first.prepared).toBe(true);
    expect(first.row).toMatchObject({ status: 'ready', pythonVersion: PINNED_PYTHON_VERSION });
    expect(readFileSync(path.join(store.paths.envDir, '.python-version'), 'utf8').trim()).toBe(PINNED_PYTHON_VERSION);
    expect(existsSync(path.join(store.paths.envDir, 'uv.lock'))).toBe(true);
    expect(environments.findByFingerprint(first.row.fingerprint!)?.id).toBe(first.row.id);
    const count = fake.calls.length;
    const second = await provisioner.ensureRuntime('script', new AbortController().signal);
    expect(second).toMatchObject({ prepared: false });
    expect(fake.calls).toHaveLength(count);
    expect(fake.calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(1);
  });

  it('shares one sync while callers wait and only cancels when the final waiter leaves', async () => {
    const { fake, provisioner } = setup((args) => args[0] === 'sync' ? { hang: true } : { exitCode: 0 });
    const first = new AbortController();
    const second = new AbortController();
    const one = provisioner.ensureRuntime('script', first.signal).catch((error: unknown) => error);
    const two = provisioner.ensureRuntime('script', second.signal).catch((error: unknown) => error);
    for (let tries = 0; tries < 100 && !fake.calls.some(({ args }) => args[0] === 'sync'); tries += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    first.abort();
    expect((await one as Error).message).toContain('cancelled');
    expect(fake.calls.some(({ command }) => command === 'taskkill')).toBe(false);
    second.abort();
    expect((await two as Error).message).toContain('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(1);
    expect(fake.calls.some(({ command }) => command === 'taskkill')).toBe(true);
  });

  it('detects a modified installed lock and repairs it from the committed copy', async () => {
    const { store, provisioner, fake, environments } = setup();
    const ready = await provisioner.ensureRuntime('script', new AbortController().signal);
    writeFileSync(path.join(store.paths.envDir, 'uv.lock'), '# changed');
    expect(provisioner.getReadiness('script')).toMatchObject({ ready: false });
    const repaired = await provisioner.ensureRuntime('script', new AbortController().signal);
    expect(repaired).toMatchObject({ prepared: true });
    expect(repaired.row.id).toBe(ready.row.id);
    expect(environments.getLatest('script')?.status).toBe('ready');
    expect(fake.calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(2);
  });

  it('distinguishes package download failure from a committed lock mismatch', async () => {
    const unavailable = setup((args) => args[0] === 'sync' ? { exitCode: 1, stderr: 'network unavailable' } : {});
    await expect(unavailable.provisioner.ensureRuntime('script', new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_PREPARE_FAILED' });
    const mismatch = setup((args) => args[0] === 'sync' ? { exitCode: 1, stderr: 'lockfile needs to be updated' } : {});
    await expect(mismatch.provisioner.ensureRuntime('script', new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_LOCK_MISMATCH' });
  });
});
