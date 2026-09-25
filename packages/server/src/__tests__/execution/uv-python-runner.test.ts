import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PythonRuntimeUnavailableError } from '@automate/core';
import { ProcessRunner } from '../../execution/process-runner';
import { MinimalUvPythonRunner, PYTHON_INSTALL_HINT } from '../../execution/uv-python-runner';
import { GENERATION_DEPENDENCY_SET, renderPyproject } from '../../execution/python-dependency-set';
import { FakePythonRunner } from '../../execution/testing/fake-python-runner';
import { fakeSpawn, type FakeBehavior } from './fake-spawn';

// Suite-level guard: no test in this file may start a real process.
const realSpawns = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (command: string) => { realSpawns.push(command); throw new Error('A real process was spawned in a unit test.'); };
  return { ...actual, default: { ...actual, spawn }, spawn };
});

let envDir: string;
beforeEach(() => { envDir = mkdtempSync(path.join(tmpdir(), 'automate-env-')); });
afterEach(() => { rmSync(envDir, { recursive: true, force: true }); expect(realSpawns).toEqual([]); });

const LIST = 'cpython-3.13.1-windows-x86_64-none    C:\\Python313\\python.exe\ncpython-3.12.4-windows-x86_64-none    C:\\Users\\me\\python.exe\n';
function runner(behave: (command: string, args: readonly string[]) => FakeBehavior, options: { platform?: NodeJS.Platform; dependencies?: readonly string[]; baseEnv?: NodeJS.ProcessEnv } = {}) {
  const fake = fakeSpawn(behave);
  const platform = options.platform ?? 'linux';
  const instance = new MinimalUvPythonRunner({ envDir, platform, processes: new ProcessRunner({ spawn: fake.spawn, platform, killGroup: fake.kill }), ...(options.dependencies ? { dependencies: options.dependencies } : {}), baseEnv: options.baseEnv ?? { PATH: '/usr/bin' } });
  return { instance, fake };
}
/** An environment already prepared by an earlier process: current project file and its lock. */
const seedPrepared = () => { writeFileSync(path.join(envDir, 'pyproject.toml'), renderPyproject(GENERATION_DEPENDENCY_SET)); writeFileSync(path.join(envDir, 'uv.lock'), 'lock'); };
const verbs = (calls: readonly { args: readonly string[] }[]) => calls.map(({ args }) => args.slice(0, 2).join(' '));

describe('MinimalUvPythonRunner.probe', () => {
  it('returns versions only when uv and a Python 3.11+ are present — never an interpreter path', async () => {
    const { instance } = runner((_, args) => ({ stdout: args[0] === '--version' ? 'uv 0.11.32 (abc 2026-07-23)\n' : LIST }));
    const info = await instance.probe();
    expect(info).toEqual({ uvVersion: 'uv 0.11.32 (abc 2026-07-23)', pythonVersion: '3.13.1' });
    expect(JSON.stringify(info)).not.toContain('\\');
  });

  it.each([
    ['win32', 'winget install astral-sh.uv'],
    ['linux', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
    ['darwin', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
  ] as const)('names uv and the %s install hint when uv is missing', async (platform, hint) => {
    const { instance } = runner(() => ({ error: new Error('spawn uv ENOENT') }), { platform });
    const error = await instance.probe().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PythonRuntimeUnavailableError);
    expect((error as PythonRuntimeUnavailableError).tool).toBe('uv');
    expect((error as Error).message).toContain(hint);
  });

  it('names Python when uv works but no 3.11+ interpreter is installed', async () => {
    const { instance } = runner((_, args) => ({ stdout: args[0] === '--version' ? 'uv 0.11.32\n' : 'cpython-3.10.9-linux    /usr/bin/python3.10\n' }));
    const error = await instance.probe().catch((cause: unknown) => cause) as PythonRuntimeUnavailableError;
    expect(error.tool).toBe('Python');
    expect(error.message).toContain(PYTHON_INSTALL_HINT);
  });

  it('reports a failing probe as unavailable rather than crashing', async () => {
    const { instance } = runner((_, args) => (args[0] === '--version' ? { stdout: 'uv 0.11.32\n' } : { exitCode: 2, stderr: 'boom' }));
    await expect(instance.probe()).rejects.toBeInstanceOf(PythonRuntimeUnavailableError);
  });
});

describe('MinimalUvPythonRunner.ensureEnvironment', () => {
  it('writes pyproject.toml, locks when no lockfile exists, then syncs with --locked', async () => {
    const { instance, fake } = runner((_, args) => { if (args[0] === 'lock') writeFileSync(path.join(envDir, 'uv.lock'), 'lock'); return { exitCode: 0 }; });
    await instance.ensureEnvironment(new AbortController().signal);
    expect(readFileSync(path.join(envDir, 'pyproject.toml'), 'utf8')).toBe(renderPyproject(GENERATION_DEPENDENCY_SET));
    expect(fake.calls.map(({ args }) => args)).toEqual([['lock', '--project', envDir], ['sync', '--locked', '--project', envDir]]);
  });

  it('skips the sync on a second call when the rendered content is unchanged', async () => {
    const { instance, fake } = runner(() => ({ exitCode: 0 }));
    seedPrepared();
    await instance.ensureEnvironment(new AbortController().signal);
    await instance.ensureEnvironment(new AbortController().signal);
    expect(verbs(fake.calls)).toEqual(['sync --locked']);
  });

  it('re-locks and re-syncs when the dependency set changes, discarding the stale lock', async () => {
    writeFileSync(path.join(envDir, 'uv.lock'), 'old-lock');
    await runner(() => ({ exitCode: 0 })).instance.ensureEnvironment(new AbortController().signal);
    const { instance, fake } = runner(() => ({ exitCode: 0 }), { dependencies: [...GENERATION_DEPENDENCY_SET, 'numpy'] });
    await instance.ensureEnvironment(new AbortController().signal);
    expect(readFileSync(path.join(envDir, 'pyproject.toml'), 'utf8')).toContain('"numpy"');
    expect(verbs(fake.calls)).toEqual(['lock --project', 'sync --locked']);
  });

  it('prepares once for three concurrent callers', async () => {
    seedPrepared();
    const { instance, fake } = runner(() => ({ exitCode: 0 }));
    await Promise.all([1, 2, 3].map(() => instance.ensureEnvironment(new AbortController().signal)));
    expect(fake.calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(1);
  });

  it('turns a failed sync into a plain-English runtime error and retries next time', async () => {
    seedPrepared();
    let fail = true;
    const { instance, fake } = runner(() => ({ exitCode: fail ? 1 : 0 }));
    await expect(instance.ensureEnvironment(new AbortController().signal)).rejects.toThrow(/could not be prepared \(uv sync exited with code 1\)/);
    fail = false;
    await instance.ensureEnvironment(new AbortController().signal);
    expect(fake.calls).toHaveLength(2);
  });

  it('cancels an in-flight sync through its signal', async () => {
    seedPrepared();
    const { instance } = runner(() => ({ hang: true }));
    const controller = new AbortController();
    const pending = instance.ensureEnvironment(controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(existsSync(path.join(envDir, 'pyproject.toml'))).toBe(true);
  });
});

describe('MinimalUvPythonRunner.run', () => {
  const request = (overrides: Partial<Parameters<MinimalUvPythonRunner['run']>[0]> = {}) => ({ executionId: 7, workingDir: path.join(envDir, 'attempt-1'), args: ['-m', 'pytest', '-q'], env: { AUTOMATE_INPUT_DIR: '/data/fixtures', AUTOMATE_OUTPUT_DIR: '/data/attempt-1/output' }, timeoutMs: 1000, signal: new AbortController().signal, ...overrides });

  it.each([[0, 'passed'], [1, 'failed'], [2, 'errored'], [3, 'errored'], [4, 'errored'], [5, 'errored']] as const)('maps exit code %i to %s', async (code, outcome) => {
    const { instance } = runner(() => ({ exitCode: code }));
    expect((await instance.run(request())).outcome).toBe(outcome);
  });

  it('runs uv run --no-sync --locked in exactly the requested directory with an app-built argument vector', async () => {
    const { instance, fake } = runner(() => ({ exitCode: 0 }));
    await instance.run(request());
    expect(fake.calls[0]).toMatchObject({ command: 'uv', args: ['run', '--project', envDir, '--no-sync', '--locked', '--', 'python', '-m', 'pytest', '-q'], options: { cwd: path.join(envDir, 'attempt-1'), shell: false } });
  });

  it('passes the two I/O directories and withholds this application\'s settings and credential-shaped variables', async () => {
    const { instance, fake } = runner(() => ({ exitCode: 0 }), { baseEnv: { PATH: '/usr/bin', AUTOMATE_HOME: '/home/me/.automate', AUTOMATE_PORT: '4317', ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'ghp', VIRTUAL_ENV: '/venv', LANG: 'C' } });
    await instance.run(request());
    const env = fake.calls[0]!.options.env!;
    expect(env).toMatchObject({ PATH: '/usr/bin', LANG: 'C', AUTOMATE_INPUT_DIR: '/data/fixtures', AUTOMATE_OUTPUT_DIR: '/data/attempt-1/output', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' });
    expect(Object.keys(env).filter((name) => name.startsWith('AUTOMATE_')).sort()).toEqual(['AUTOMATE_INPUT_DIR', 'AUTOMATE_OUTPUT_DIR']);
    expect(JSON.stringify(env)).not.toMatch(/sk-secret|ghp|\/home\/me/);
  });

  it('yields timed_out with the partial output, and aborted when cancelled', async () => {
    const hanging = runner(() => ({ stdout: 'collected 3 items', hang: true }));
    const timedOut = await hanging.instance.run(request({ timeoutMs: 10 }));
    expect(timedOut).toMatchObject({ outcome: 'timed_out', exitCode: null, stdout: 'collected 3 items' });
    const controller = new AbortController();
    const pending = runner(() => ({ hang: true })).instance.run(request({ signal: controller.signal }));
    controller.abort();
    expect((await pending).outcome).toBe('aborted');
  });

  it('kills the tree with the platform-correct command', async () => {
    const windows = runner(() => ({ hang: true }), { platform: 'win32' });
    await windows.instance.run(request({ timeoutMs: 10 }));
    expect(windows.fake.calls.at(-1)).toMatchObject({ command: 'taskkill', args: ['/pid', String(windows.fake.calls[0]!.pid), '/T', '/F'] });
  });
});

describe('FakePythonRunner', () => {
  it('returns scripted results in order, records requests, and honors cancellation', async () => {
    const fake = new FakePythonRunner([{ result: { outcome: 'failed', exitCode: 1 } }, {}]);
    const signal = new AbortController().signal;
    const base = { executionId: 1, workingDir: 'w', args: [], env: {}, timeoutMs: 1, signal };
    expect((await fake.run(base)).outcome).toBe('failed');
    expect((await fake.run(base)).outcome).toBe('passed');
    expect(fake.requests).toHaveLength(2);
    const controller = new AbortController();
    const gated = new FakePythonRunner([{ waitUntil: new Promise(() => undefined) }]).run({ ...base, signal: controller.signal });
    controller.abort();
    expect((await gated).outcome).toBe('aborted');
    await expect(new FakePythonRunner([], { probeError: new Error('no uv') }).probe()).rejects.toThrow('no uv');
  });
});
