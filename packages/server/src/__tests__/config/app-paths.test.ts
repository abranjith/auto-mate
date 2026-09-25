import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { ConfigurationError, ValidationError } from '@automate/core';
import { ensureAppDirectories, getAppPaths, resolveWithin } from '../../config/app-paths';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('application paths', () => {
  it('uses the home directory by default', () => expect(getAppPaths('').root).toBe(path.join(homedir(), '.automate')));
  it('honors an absolute or relative override', () => {
    expect(getAppPaths('custom').root).toBe(path.resolve('custom'));
    expect(getAppPaths(path.join(tmpdir(), 'custom')).root).toBe(path.resolve(tmpdir(), 'custom'));
  });
  it('creates the five storage directories idempotently', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-')); temporary.push(root);
    const paths = getAppPaths(root);
    ensureAppDirectories(paths);
    ensureAppDirectories(paths);
    for (const dir of [paths.dataDir, paths.artifactsDir, paths.uploadsDir, paths.scriptsDir, paths.envDir, paths.verifyEnvDir, paths.runsDir]) expect(existsSync(dir)).toBe(true);
  });
  it('rejects a file as root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-')); temporary.push(root);
    const file = path.join(root, 'file'); writeFileSync(file, 'x');
    expect(() => ensureAppDirectories(getAppPaths(file))).toThrow(ConfigurationError);
  });
  it('accepts children and rejects escapes', () => {
    const base = path.resolve(tmpdir(), 'automate');
    expect(resolveWithin(base, 'task', 'output.csv')).toBe(path.join(base, 'task', 'output.csv'));
    expect(() => resolveWithin(base, '..', 'escape')).toThrow(ValidationError);
    expect(() => resolveWithin(base, path.resolve(tmpdir(), 'outside'))).toThrow(ValidationError);
    if (process.platform === 'win32') expect(() => resolveWithin(base, '..\\outside')).toThrow(ValidationError);
  });
});
