import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTree } from '../../history/safe-remove';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('safe removal', () => {
  it('rejects traversal and deletes a link without following its target', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-remove-')); roots.push(root);
    const base = path.join(root, 'runs'); const outside = path.join(root, 'outside');
    mkdirSync(base); mkdirSync(outside); writeFileSync(path.join(outside, 'sentinel'), 'keep');
    for (const name of ['..', '../x', '5/../../x', path.resolve(root, 'outside'), 'agent-smoke']) expect((await removeTree(base, name)).removed).toBe(false);
    symlinkSync(outside, path.join(base, '1'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await removeTree(base, '1')).removed).toBe(true);
    expect(existsSync(path.join(outside, 'sentinel'))).toBe(true);
    expect(existsSync(path.join(base, '1'))).toBe(false);
  });
});
