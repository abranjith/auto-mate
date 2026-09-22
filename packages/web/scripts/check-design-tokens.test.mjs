import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDesignTokens } from './check-design-tokens.mjs';

test('accepts tokens, flags raw utilities with a file, and ignores design-system', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokens-'));
  try {
    writeFileSync(join(root, 'good.tsx'), '<div className={ds.card} />');
    assert.deepEqual(checkDesignTokens(root), []);
    writeFileSync(join(root, 'bad.tsx'), '<div className="bg-blue-500" />');
    assert.match(checkDesignTokens(root).join(), /bad\.tsx:1/);
    rmSync(join(root, 'bad.tsx'));
    mkdirSync(join(root, 'design-system'));
    writeFileSync(join(root, 'design-system', 'ignored.tsx'), '<div className="bg-blue-500" />');
    assert.deepEqual(checkDesignTokens(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
