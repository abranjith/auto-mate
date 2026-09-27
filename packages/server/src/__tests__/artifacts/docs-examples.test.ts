// FEAT-109 TASK-014: the documented types, limits, CSP, preview caveat, and
// output rules are checked against the code, so a change that invalidates the
// docs fails the build.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_CSP, ARTIFACT_TYPES, ARTIFACT_TYPE_POLICY, FORMULA_SCAN_ROWS, MAX_ARCHIVE_BYTES, MAX_ARTIFACTS_PER_RUN, MAX_ARTIFACT_PREVIEW_BYTES, MAX_TABLE_PAGE_ROWS, MAX_TABLE_SCAN_ROWS, OUTPUT_CONTRACT_RULES, describeArtifactSafety } from '@automate/core';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(path.join(repo, ...parts), 'utf8');
const featurePage = read('docs', 'features', 'results-outputs-downloads.md');
const serverReadme = read('packages', 'server', 'README.md');
const envSource = read('packages', 'server', 'src', 'config', 'env.ts');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const LIMITS: Readonly<Record<string, number>> = {
  AUTOMATE_MAX_ARTIFACTS_PER_RUN: MAX_ARTIFACTS_PER_RUN,
  AUTOMATE_MAX_ARTIFACT_PREVIEW_BYTES: MAX_ARTIFACT_PREVIEW_BYTES,
  AUTOMATE_MAX_TABLE_PAGE_ROWS: MAX_TABLE_PAGE_ROWS,
  AUTOMATE_MAX_TABLE_SCAN_ROWS: MAX_TABLE_SCAN_ROWS,
  AUTOMATE_FORMULA_SCAN_ROWS: FORMULA_SCAN_ROWS,
  AUTOMATE_MAX_ARCHIVE_BYTES: MAX_ARCHIVE_BYTES,
};

describe('FEAT-109 documentation matches the code', () => {
  it('documents exactly the policy\'s types with their extensions', () => {
    for (const type of ARTIFACT_TYPES) {
      const extensions = ARTIFACT_TYPE_POLICY[type].extensions.map((extension) => `\`${extension}\``).join(', ');
      expect(featurePage, type).toContain(`| \`${type}\` | ${extensions} |`);
    }
    const documented = [...featurePage.matchAll(/^\| `([a-z-]+)` \| `\./gm)].map(([, type]) => type);
    expect(documented.sort()).toEqual([...ARTIFACT_TYPES].sort());
  });

  it('quotes the CSP verbatim', () => {
    expect(featurePage).toContain(ARTIFACT_CSP);
  });

  it('quotes the preview caveat verbatim, from its one source', () => {
    for (const line of describeArtifactSafety('sandboxed_html')) expect(flat(featurePage), line).toContain(line);
  });

  it('documents every artifact environment variable with its default, in the feature page and the server README', () => {
    for (const [name, value] of Object.entries(LIMITS)) {
      expect(envSource, name).toContain(`'${name}'`);
      for (const text of [featurePage, serverReadme]) expect(text, name).toMatch(new RegExp(`\\| \`${name}\` \\| \`${value}\` \\|`));
    }
    expect(serverReadme).toMatch(/six limits are \*\*provisional against open D14\*\*/);
  });

  it('keeps the documented output rules in step with the contract the agent is given', () => {
    // Changing a rule means editing this list and the "Self-contained outputs" section of the feature page.
    expect(OUTPUT_CONTRACT_RULES.map((rule) => rule.slice(0, 40))).toEqual([
      'Declare every output file in the manifes',
      'Write self-contained files. Results are ',
      'Keep every output file under 512 MB.',
      'When you draw a chart, also write the nu',
      'Only this Python script is run: shell sc',
    ]);
    for (const phrase of ['Never write `.svg` files.', 'include_plotlyjs=True', "never `'cdn'`", '`data:` URIs', 'under 512 MB', 'write the numbers behind it as a CSV', 'shell scripts are not executed']) expect(flat(featurePage), phrase).toContain(phrase);
  });

  it('states both claims this feature must not overstate', () => {
    expect(flat(featurePage)).toMatch(/The preview frame protects your browser, not your computer\./);
    expect(flat(featurePage)).toMatch(/ran unisolated on your computer/);
    expect(flat(featurePage)).toMatch(/The formula notice is information, not protection\./);
  });

  it('states retention in the same words for inputs and outputs', () => {
    expect(flat(featurePage)).toContain('Outputs live for the life of the task, are deleted with it, and are never purged by age.');
  });
});
