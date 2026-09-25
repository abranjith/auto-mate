import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRunner } from '../../execution/process-runner';
import { fakeSpawn } from './fake-spawn';

// Suite-level guard: no test in this file may start a real process.
const realSpawns = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = (command: string) => { realSpawns.push(command); throw new Error('A real process was spawned in a unit test.'); };
  return { ...actual, default: { ...actual, spawn }, spawn };
});
afterEach(() => expect(realSpawns).toEqual([]));

describe('ProcessRunner', () => {
  it('runs a command with shell disabled and captures its output and exit code', async () => {
    const fake = fakeSpawn(() => ({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 }));
    const result = await new ProcessRunner({ spawn: fake.spawn, platform: 'linux' }).run({ command: 'uv', args: ['--version'], cwd: '/work', timeoutMs: 1000 });
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', droppedBytes: 0, timedOut: false, aborted: false, spawnError: null });
    expect(fake.calls[0]).toMatchObject({ command: 'uv', args: ['--version'], options: { cwd: '/work', shell: false, windowsHide: true, detached: true } });
  });

  it('spawns attached on Windows, where the tree is killed by taskkill instead of a process group', async () => {
    const fake = fakeSpawn();
    await new ProcessRunner({ spawn: fake.spawn, platform: 'win32' }).run({ command: 'uv', args: [], timeoutMs: 1000 });
    expect(fake.calls[0]!.options.detached).toBe(false);
  });

  it('reports a missing executable as a spawn error rather than rejecting', async () => {
    const fake = fakeSpawn(() => ({ error: Object.assign(new Error('spawn uv ENOENT'), { code: 'ENOENT' }) }));
    const result = await new ProcessRunner({ spawn: fake.spawn }).run({ command: 'uv', args: [], timeoutMs: 1000 });
    expect(result.spawnError?.message).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
    const throwing = await new ProcessRunner({ spawn: () => { throw new Error('EACCES'); } }).run({ command: 'uv', args: [], timeoutMs: 1000 });
    expect(throwing.spawnError?.message).toBe('EACCES');
  });

  it('kills the whole tree with taskkill /T /F on Windows when the timeout passes, keeping partial output', async () => {
    const fake = fakeSpawn((command) => (command === 'uv' ? { stdout: 'partial', hang: true } : { exitCode: 0 }));
    const result = await new ProcessRunner({ spawn: fake.spawn, platform: 'win32' }).run({ command: 'uv', args: ['run'], timeoutMs: 20 });
    expect(result).toMatchObject({ timedOut: true, aborted: false, exitCode: null, stdout: 'partial' });
    const pid = fake.calls[0]!.pid;
    expect(fake.calls[1]).toMatchObject({ command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] });
  });

  it('signals the process group on POSIX when aborted', async () => {
    const fake = fakeSpawn(() => ({ hang: true }));
    const killed: number[] = [];
    const controller = new AbortController();
    const running = new ProcessRunner({ spawn: fake.spawn, platform: 'darwin', killGroup: (pid) => { killed.push(pid); fake.kill(pid); } }).run({ command: 'uv', args: ['run'], timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await running;
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(killed).toEqual([fake.calls[0]!.pid]);
    expect(fake.calls).toHaveLength(1);
  });

  it('does not spawn at all when already aborted', async () => {
    const fake = fakeSpawn();
    const controller = new AbortController();
    controller.abort();
    expect((await new ProcessRunner({ spawn: fake.spawn }).run({ command: 'uv', args: [], timeoutMs: 1000, signal: controller.signal })).aborted).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it('bounds a 12 MB stdout, keeping the start and the end and counting what was dropped', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    const chunks = [Buffer.from('FIRST-LINE\n'), ...Array.from({ length: 12 }, () => chunk), Buffer.from('\n1 failed, 2 passed in 0.10s\n')];
    const fake = fakeSpawn(() => ({ stdout: chunks, exitCode: 1 }));
    const result = await new ProcessRunner({ spawn: fake.spawn, maxCaptureBytes: 65_536 }).run({ command: 'uv', args: [], timeoutMs: 5000 });
    const total = chunks.reduce((sum, item) => sum + item.length, 0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65_536 + 1);
    expect(result.droppedBytes).toBe(total - 65_536);
    expect(result.stdout.startsWith('FIRST-LINE')).toBe(true);
    expect(result.stdout.endsWith('1 failed, 2 passed in 0.10s\n')).toBe(true);
  });

  it('logs a failed tree kill instead of throwing or swallowing it', async () => {
    const fake = fakeSpawn(() => ({ hang: true }));
    const warn = vi.fn();
    const runner = new ProcessRunner({ spawn: fake.spawn, platform: 'linux', killGroup: (pid) => { fake.kill(pid); throw new Error('ESRCH'); }, logger: { warn } });
    const result = await runner.run({ command: 'uv', args: [], timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ cause: 'ESRCH' }), 'process tree kill failed');
  });
});
