import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProcessRunner } from '../../execution/process-runner';
import { LOCKED_COMMANDS } from '../../execution/dependency-policy';
import { VerifyEnvironment, renderBanditConfig, renderBanditIni } from '../../verification/verify-env';
import { fakeSpawn } from '../execution/fake-spawn';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('VerifyEnvironment', () => {
  it('delegates preparation and writes trusted checker configuration', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'automate-verify-'));
    dirs.push(dir);
    const fake = fakeSpawn();
    const calls: string[] = [];
    const env = new VerifyEnvironment({ verifyEnvDir: dir, provisioner: { ensureRuntime: async (kind) => { calls.push(kind); return { row: {} as never, prepared: false }; } }, processes: new ProcessRunner({ spawn: fake.spawn, platform: 'linux' }), platform: 'linux' });
    await env.ensureVerifyEnvironment(new AbortController().signal);
    expect(calls).toEqual(['verify']);
    expect(readFileSync(env.banditConfigPath, 'utf8')).toBe(renderBanditConfig());
    expect(readFileSync(env.banditIniPath, 'utf8')).toBe(renderBanditIni());
    expect(fake.calls).toEqual([]);
  });

  it('runs checkers from verify-env with locked arguments and no credentials', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'automate-verify-'));
    dirs.push(dir);
    const fake = fakeSpawn(() => ({ stdout: 'ruff 0.16.9\n' }));
    const env = new VerifyEnvironment({ verifyEnvDir: dir, provisioner: { ensureRuntime: async () => ({ row: {} as never, prepared: false }) }, processes: new ProcessRunner({ spawn: fake.spawn, platform: 'linux' }), platform: 'linux', baseEnv: { PATH: '/bin', OPENAI_API_KEY: 'secret' } });
    const args = ['check', '--isolated', 'main.py'];
    await env.runTool('ruff', args, 1000, new AbortController().signal);
    expect(fake.calls[0]!.args).toEqual(LOCKED_COMMANDS.runChecker(dir, 'ruff', args));
    expect(fake.calls[0]!.options).toMatchObject({ cwd: dir, shell: false, detached: true });
    expect(fake.calls[0]!.options.env).not.toHaveProperty('OPENAI_API_KEY');
  });
});
