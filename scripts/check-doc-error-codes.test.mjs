import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDocErrorCodes } from './check-doc-error-codes.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Build a throwaway repository with the real error codes and the supplied docs. */
function fixture(docs) {
  const root = mkdtempSync(join(tmpdir(), 'doc-codes-'));
  mkdirSync(join(root, 'packages/core/src/errors'), { recursive: true });
  cpSync(join(repoRoot, 'packages/core/src/errors/error-codes.ts'), join(root, 'packages/core/src/errors/error-codes.ts'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (const name of ['README.md', 'CHANGELOG.md']) writeFileSync(join(root, name), '# Placeholder\n');
  for (const pkg of ['core', 'server', 'web']) {
    mkdirSync(join(root, 'packages', pkg), { recursive: true });
    writeFileSync(join(root, 'packages', pkg, 'README.md'), '# Placeholder\n');
  }
  writeFileSync(join(root, 'docs/guide.md'), docs);
  return root;
}

test('accepts a document using only defined error codes', () => {
  const root = fixture('Errors report `AGENT_AUTH_UNAVAILABLE` and `VALIDATION_ERROR`.\n');
  assert.deepEqual(checkDocErrorCodes(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('rejects a documented error code that does not exist', () => {
  const root = fixture('Errors report `AGENT_MADE_UP_CODE`.\n');
  const violations = checkDocErrorCodes(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /AGENT_MADE_UP_CODE/);
  rmSync(root, { recursive: true, force: true });
});

test('accepts isolation wording that denies the guarantee', () => {
  const root = fixture('This milestone has no enforced isolation boundary. Working directories are not a security boundary.\n');
  assert.deepEqual(checkDocErrorCodes(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('rejects an affirmative isolation claim', () => {
  const root = fixture('Generated code runs in a sandbox.\n');
  const violations = checkDocErrorCodes(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /D03/);
  rmSync(root, { recursive: true, force: true });
});

test('rejects an instruction to type an API key into the interface', () => {
  const root = fixture('Paste your API key into the settings form to continue.\n');
  const violations = checkDocErrorCodes(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /API key/);
  rmSync(root, { recursive: true, force: true });
});

test('passes against the real documentation set', () => {
  assert.deepEqual(checkDocErrorCodes(repoRoot), []);
});
