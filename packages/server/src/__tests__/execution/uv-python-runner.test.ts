import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NonPythonEntrypointError } from '@automate/core';
import { deployLauncher } from '../../execution/launcher-deploy';
import { ProcessRunner } from '../../execution/process-runner';
import { UvPythonRunner, outcomeOf } from '../../execution/uv-python-runner';
import { LOCKED_COMMANDS, PINNED_PYTHON_VERSION } from '../../execution/dependency-policy';
import { fakeSpawn, type FakeBehavior } from './fake-spawn';

const realSpawns = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (command: string) => { realSpawns.push(command); throw new Error('Real process spawned in unit test'); };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

let envDir: string;
beforeEach(() => { envDir = mkdtempSync(path.join(tmpdir(), 'automate-env-')); });
afterEach(() => { rmSync(envDir, { recursive: true, force: true }); expect(realSpawns).toEqual([]); });
const request = (args: readonly string[] = ['main.py']) => ({ executionId: 1, workingDir: 'C:/scripts', args, env: { AUTOMATE_INPUT_DIR: 'C:/input', AUTOMATE_OUTPUT_DIR: 'C:/output' }, timeoutMs: 1000, signal: new AbortController().signal });

function setup(behavior: (command: string, args: readonly string[]) => FakeBehavior = () => ({ exitCode: 0 }), platform: NodeJS.Platform = 'win32') {
  const fake = fakeSpawn(behavior);
  const launcher = deployLauncher(envDir);
  const provisioner = { ensureRuntime: vi.fn(async () => ({ row: {} as never, prepared: false })), getReadiness: vi.fn(() => ({ ready: true, environment: { kind: 'script' as const, status: 'ready' as const, pythonVersion: PINNED_PYTHON_VERSION, uvVersion: 'uv 0.11.32', fingerprint: 'f', lockDigest: 'a', packageCount: 0, packages: [], preparedAt: null, failureReason: null }, reason: null })), probeUv: vi.fn(async () => 'uv 0.11.32'), getLauncherDigest: () => launcher.digest };
  const runner = new UvPythonRunner({ envDir, provisioner, platform, processes: new ProcessRunner({ spawn: fake.spawn, platform, killGroup: fake.kill }), baseEnv: { PATH: 'C:/bin', AUTOMATE_HOME: 'C:/secret', OPENAI_API_KEY: 'secret' } });
  return { fake, runner, provisioner, launcher };
}

describe('UvPythonRunner', () => {
  it('uses the stored runtime without a new process and delegates preparation', async () => {
    const { runner, provisioner, fake } = setup();
    expect(await runner.probe()).toEqual({ pythonVersion: PINNED_PYTHON_VERSION, uvVersion: 'uv 0.11.32' });
    await runner.ensureEnvironment(new AbortController().signal);
    expect(provisioner.ensureRuntime).toHaveBeenCalledOnce();
    expect(fake.calls).toEqual([]);
  });

  it('runs a script through the absolute trusted launcher and sanitizes the child environment', async () => {
    const { runner, fake, launcher } = setup();
    expect((await runner.run(request())).outcome).toBe('passed');
    const call = fake.calls[0]!;
    expect(call.args).toEqual(LOCKED_COMMANDS.runScript(envDir, launcher.path, 'main.py'));
    expect(path.isAbsolute(call.args[call.args.length - 2]!)).toBe(true);
    expect(call.options).toMatchObject({ shell: false, windowsHide: true, detached: false });
    expect(call.options.env).toMatchObject({ PYTHONSAFEPATH: '1', AUTOMATE_INPUT_DIR: 'C:/input', AUTOMATE_OUTPUT_DIR: 'C:/output' });
    expect(call.options.env).not.toHaveProperty('AUTOMATE_HOME');
    expect(call.options.env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('keeps pytest locked and rejects a shell entrypoint before spawning', async () => {
    const { runner, fake } = setup();
    await runner.run(request(['-m', 'pytest', '-q']));
    expect(fake.calls[0]!.args).toEqual(LOCKED_COMMANDS.runTests(envDir));
    await expect(runner.run(request(['report.sh']))).rejects.toBeInstanceOf(NonPythonEntrypointError);
    expect(fake.calls).toHaveLength(1);
  });

  it('distinguishes script exit, memory, file size, timeout, and abort', async () => {
    for (const [code, outcome] of [[0, 'passed'], [1, 'failed'], [2, 'errored'], [93, 'failed'], [94, 'failed']] as const) {
      const { runner } = setup(() => ({ exitCode: code }));
      const result = await runner.run(request());
      expect(result.outcome).toBe(outcome);
      if (code === 93) expect(result.stderr).toContain('memory limit');
      if (code === 94) expect(result.stderr).toContain('output');
    }
    expect(outcomeOf({ aborted: true, timedOut: false, exitCode: null } as never)).toBe('aborted');
    expect(outcomeOf({ aborted: false, timedOut: true, exitCode: null } as never)).toBe('timed_out');
  });

  it('uses a POSIX process group outside Windows', async () => {
    const { runner, fake } = setup(() => ({ exitCode: 0 }), 'linux');
    await runner.run(request());
    expect(fake.calls[0]!.options).toMatchObject({ shell: false, detached: true });
  });
});
