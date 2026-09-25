// FEAT-107 TASK-017: the documented behavior is generated from — and checked
// against — the code, so a policy change that invalidates the docs fails the build.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BLOCKING_BANDIT_CONFIDENCE, BLOCKING_BANDIT_SEVERITY, BLOCKING_RUFF_RULE_CODES, BLOCKING_RUFF_RULE_PREFIXES, CHECK_KEYS, LINT_TIMEOUT_MS, MAX_REVIEW_FEEDBACK_CHARS, MAX_RUN_OUTPUT_BYTES, RUN_INTENT_CAVEATS, SCRIPT_RUN_TIMEOUT_MS, SECURITY_TIMEOUT_MS, VERIFICATION_TIMEOUT_MS } from '@automate/core';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const featurePage = readFileSync(path.join(repo, 'docs', 'features', 'verification-execution-gate.md'), 'utf8');
const serverReadme = readFileSync(path.join(repo, 'packages', 'server', 'README.md'), 'utf8');
const envSource = readFileSync(path.join(repo, 'packages', 'server', 'src', 'config', 'env.ts'), 'utf8');

describe('FEAT-107 documentation matches the code', () => {
  it('names every check key', () => {
    for (const key of CHECK_KEYS) expect(featurePage, key).toContain(`\`${key}\``);
  });
  it('states every blocking ruff rule and the bandit threshold', () => {
    for (const rule of [...BLOCKING_RUFF_RULE_PREFIXES, ...BLOCKING_RUFF_RULE_CODES]) expect(featurePage, rule).toContain(`\`${rule}\``);
    expect(featurePage).toMatch(new RegExp(`${BLOCKING_BANDIT_SEVERITY}[^.]*${BLOCKING_BANDIT_CONFIDENCE}`, 'i'));
  });
  it('quotes the three gate caveats verbatim', () => {
    for (const caveat of RUN_INTENT_CAVEATS) expect(featurePage.replace(/\s+/g, ' ')).toContain(caveat);
  });
  it('documents every verification environment variable in the server README with its default', () => {
    const defaults: Record<string, number> = { AUTOMATE_VERIFICATION_TIMEOUT_MS: VERIFICATION_TIMEOUT_MS, AUTOMATE_LINT_TIMEOUT_MS: LINT_TIMEOUT_MS, AUTOMATE_SECURITY_TIMEOUT_MS: SECURITY_TIMEOUT_MS, AUTOMATE_SCRIPT_RUN_TIMEOUT_MS: SCRIPT_RUN_TIMEOUT_MS, AUTOMATE_MAX_RUN_OUTPUT_BYTES: MAX_RUN_OUTPUT_BYTES, AUTOMATE_MAX_REVIEW_FEEDBACK_CHARS: MAX_REVIEW_FEEDBACK_CHARS };
    for (const name of Object.keys(defaults)) expect(envSource, name).toContain(`'${name}'`);
    for (const [name, value] of Object.entries(defaults)) expect(serverReadme, name).toMatch(new RegExp(`\`${name}\` \\((?:default )?\`${value}\`\\)`));
    expect(serverReadme).toMatch(/provisional against open D14/);
  });
  it('never calls the hygiene measures a security boundary', () => {
    for (const text of [featurePage, serverReadme]) expect(text).not.toMatch(/\b(?:is|are|provides?) (?:a )?(?:security boundary|sandbox)\b/i);
  });
});
