import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGenerationConfig, type GenerationConfig } from '../../config/env';
import { SCRIPT_DEPENDENCY_SET } from '../../execution/dependency-policy';

// The documented limits and package list are generated from the code here, so
// a change to either that invalidates the docs fails the build.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const FEATURE_PAGE = 'docs/features/code-generation-repair.md';
const SERVER_README = 'packages/server/README.md';

const VARIABLES: Readonly<Record<keyof GenerationConfig, string>> = {
  maxAttempts: 'AUTOMATE_MAX_GENERATION_ATTEMPTS',
  timeoutMs: 'AUTOMATE_GENERATION_TIMEOUT_MS',
  maxCostUsd: 'AUTOMATE_MAX_GENERATION_COST_USD',
  testRunTimeoutMs: 'AUTOMATE_TEST_RUN_TIMEOUT_MS',
  uvSyncTimeoutMs: 'AUTOMATE_UV_SYNC_TIMEOUT_MS',
  fixtureRowCount: 'AUTOMATE_FIXTURE_ROW_COUNT',
  maxScriptBytes: 'AUTOMATE_MAX_SCRIPT_BYTES',
};

describe('docs-examples: generation', () => {
  it('lists exactly the provisional dependency set, in order, on the feature page and in the server README', () => {
    const listed = SCRIPT_DEPENDENCY_SET.map(({ name }) => `\`${name}\``);
    const phrase = `${listed.slice(0, -1).join(', ')}, and ${listed.at(-1)}`;
    expect(read(FEATURE_PAGE)).toContain(phrase);
    expect(read(SERVER_README)).toContain(SCRIPT_DEPENDENCY_SET.map(({ name }) => `\`${name}\``).join(', '));
  });

  it('documents every generation variable with its current default, marked provisional', () => {
    const defaults = getGenerationConfig({});
    const page = read(FEATURE_PAGE);
    const readme = read(SERVER_README);
    for (const [key, variable] of Object.entries(VARIABLES) as [keyof GenerationConfig, string][]) {
      const value = String(defaults[key]);
      expect(page).toMatch(new RegExp(`\\| \`${variable}\` \\| \`${value}\``));
      expect(readme).toContain(`\`${variable}\` (${key === 'maxAttempts' ? 'default ' : ''}\`${value}\``);
    }
    expect(readme).toMatch(/provisional against open D14/);
    expect(page).toMatch(/provisional against open decision D05/);
  });

  it('keeps the three sentences the page must not soften', () => {
    const page = read(FEATURE_PAGE);
    expect(page).toMatch(/without an isolation boundary/i);
    expect(page).toMatch(/--no-sync --locked[^.]*(?:not|no)\b[^.]*(?:restrict|network|reach)/i);
    expect(page).toMatch(/(?:do not|does not|not) prove it works on your file/i);
  });
});
