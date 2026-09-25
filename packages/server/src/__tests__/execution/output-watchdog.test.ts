import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectOutput, watchOutput } from '../../execution/output-watchdog';
import { ProcessRunner } from '../../execution/process-runner';
import { fakeSpawn } from './fake-spawn';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const limits = { maxFileBytes: 5, maxTotalBytes: 8, maxFiles: 2, intervalMs: 5 };

describe('output watchdog', () => {
  it('reports bytes and file count and ignores symlinks', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'automate-watch-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'one.txt'), '123456');
    expect(inspectOutput(dir, limits).breach).toBe('output_bytes');
    rmSync(path.join(dir, 'one.txt'));
    for (const name of ['a', 'b', 'c']) writeFileSync(path.join(dir, name), 'x');
    expect(inspectOutput(dir, limits).breach).toBe('output_files');
    const outside = mkdtempSync(path.join(tmpdir(), 'automate-outside-'));
    dirs.push(outside);
    writeFileSync(path.join(outside, 'large'), 'x'.repeat(100));
    symlinkSync(path.join(outside, 'large'), path.join(dir, 'link'));
    expect(inspectOutput(dir, { ...limits, maxFiles: 4 }).breach).toBeNull();
  });

  it('polls until a file crosses the cap and stops on abort', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'automate-watch-'));
    dirs.push(dir);
    const controller = new AbortController();
    const pending = watchOutput(dir, limits, controller.signal);
    writeFileSync(path.join(dir, 'big'), '123456');
    await expect(pending).resolves.toBe('output_bytes');
    const cancel = new AbortController();
    const stopped = watchOutput(dir, { ...limits, maxFileBytes: 100 }, cancel.signal);
    cancel.abort();
    await expect(stopped).resolves.toBeNull();
  });

  it('kills a hung process for output growth and records the reason', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'automate-watch-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'big'), '123456');
    const fake = fakeSpawn(() => ({ hang: true }));
    const runner = new ProcessRunner({ spawn: fake.spawn, platform: 'win32' });
    const result = await runner.run({ command: 'uv.exe', args: ['run'], timeoutMs: 1000, outputWatch: { dir, limits } });
    expect(result.limitBreached).toBe('output_bytes');
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(fake.calls.some(({ command }) => command === 'taskkill')).toBe(true);
  });
});
