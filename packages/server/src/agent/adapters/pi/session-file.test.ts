import { afterEach, describe, expect, it, vi } from 'vitest';

// `node:fs/promises` is an ESM namespace, so it cannot be spied on in place.
// The factory passes calls through except chmod, which one test makes fail to
// prove finalize() still resolves on a filesystem without POSIX permissions.
const failure = vi.hoisted(() => ({ chmod: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const chmod = async (file: Parameters<typeof actual.chmod>[0], mode: Parameters<typeof actual.chmod>[1]): Promise<void> => {
    if (failure.chmod) throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
    await actual.chmod(file, mode);
  };
  return { ...actual, default: { ...actual, chmod }, chmod };
});

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentSessionFile } from './session-file';

const temporary: string[] = [];
afterEach(() => { temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); failure.chmod = false; });

/** A fresh execution sandbox with a not-yet-created session directory. */
function sandbox(): { sessionDir: string; cwd: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'automate-session-'));
  temporary.push(root);
  return { sessionDir: path.join(root, 'agent-sessions', 'exec-1'), cwd: root };
}

describe('agent session file', () => {
  it('creates a missing session directory', async () => {
    const { sessionDir, cwd } = sandbox();
    expect(existsSync(sessionDir)).toBe(false);
    await createAgentSessionFile({ sessionDir, cwd });
    expect(existsSync(sessionDir)).toBe(true);
  });
  it('is a no-op on an existing session directory', async () => {
    const { sessionDir, cwd } = sandbox();
    await createAgentSessionFile({ sessionDir, cwd });
    await expect(createAgentSessionFile({ sessionDir, cwd })).resolves.toBeDefined();
  });
  it('creates the session directory with mode 0700 on POSIX hosts', async () => {
    const { sessionDir, cwd } = sandbox();
    await createAgentSessionFile({ sessionDir, cwd });
    if (process.platform === 'win32') return;
    expect((statSync(sessionDir).mode & 0o777).toString(8)).toBe('700');
  });
  it('reports an absolute log path inside the session directory', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    expect(path.isAbsolute(file.logPath())).toBe(true);
    expect(path.dirname(path.resolve(file.logPath()))).toBe(path.resolve(sessionDir));
    expect(file.logPath().endsWith('.jsonl')).toBe(true);
  });
  it('reports the same log path before and after finalize', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    const before = file.logPath();
    await file.finalize();
    expect(file.logPath()).toBe(before);
  });
  it('leaves a readable header file for a session that produced no output', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    await file.finalize();
    const contents = readFileSync(file.logPath(), 'utf8');
    expect(contents.length).toBeGreaterThan(0);
    const lines = contents.trimEnd().split('\n');
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });
  it('is idempotent and does not duplicate the header on a second call', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    await file.finalize();
    const first = readFileSync(file.logPath(), 'utf8');
    await file.finalize();
    expect(readFileSync(file.logPath(), 'utf8')).toBe(first);
  });
  it('restricts the artifact to mode 0600 on POSIX hosts', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    await file.finalize();
    if (process.platform === 'win32') return;
    expect((statSync(file.logPath()).mode & 0o777).toString(8)).toBe('600');
  });
  it('resolves rather than throwing when chmod is unsupported', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    failure.chmod = true;
    await expect(file.finalize()).resolves.toBeUndefined();
    expect(existsSync(file.logPath())).toBe(true);
  });
  it('records the working directory on the session manager', async () => {
    const { sessionDir, cwd } = sandbox();
    const file = await createAgentSessionFile({ sessionDir, cwd });
    expect(path.resolve(file.sessionManager.getCwd())).toBe(path.resolve(cwd));
    expect(file.sessionDir).toBe(sessionDir);
  });
});
