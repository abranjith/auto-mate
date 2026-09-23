import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Anything shaped like one of the application's stable error codes. */
const CODE_SHAPE = /\b(?:AGENT|VALIDATION|CONFIGURATION|REPOSITORY|CONNECTION|INTERNAL)_[A-Z_]+\b|\bNOT_FOUND\b/g;

/**
 * Isolation vocabulary this milestone may only use to deny a guarantee (D03).
 *
 * Any sentence mentioning one of these must also carry a negation. A lexical
 * check cannot parse meaning, but "the sentence that says `security boundary`
 * must also say `not`" catches the failure mode that matters: an affirmative
 * claim slipping into the docs.
 */
const ISOLATION_TERMS = /\b(?:sandbox(?:ed|ing)?|security boundary|isolation boundary|execution isolation)\b/i;
const NEGATIONS = /\b(?:no|not|never|without|none|nothing|cannot|neither|nor|un-?isolated|lacks?)\b/i;

/** Wording that would tell a person to type a credential into the interface. */
const KEY_ENTRY_CLAIMS = [
  /paste (?:your |the )?(?:api )?key into/i,
  /enter (?:your |the )?api key (?:in|into|on) the (?:page|form|ui|interface|settings)/i,
];

/** Collect every Markdown file that documents behavior. */
function collectMarkdown(root, collected = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const file = join(root, entry.name);
    if (entry.isDirectory()) { collectMarkdown(file, collected); continue; }
    if (entry.name.endsWith('.md')) collected.push(file);
  }
  return collected;
}

/** Read the stable codes the application actually defines. */
function definedCodes(root) {
  const source = readFileSync(join(root, 'packages/core/src/errors/error-codes.ts'), 'utf8');
  return new Set([...source.matchAll(/^\s*(\w+):\s*'(\w+)'/gm)].filter(([, key, value]) => key === value).map(([, key]) => key));
}

/**
 * Check the documentation set against the code.
 *
 * @param root Repository root.
 * @returns Violations: error codes documented but not defined, isolation claims this milestone cannot make, and instructions to type a key into the interface.
 */
export function checkDocErrorCodes(root) {
  const codes = definedCodes(root);
  const violations = [];
  const files = [...collectMarkdown(join(root, 'docs')), join(root, 'README.md'), join(root, 'CHANGELOG.md'), join(root, 'packages/core/README.md'), join(root, 'packages/server/README.md'), join(root, 'packages/web/README.md')];
  for (const file of files) {
    const markdown = readFileSync(file, 'utf8');
    const where = relative(root, file).replace(/\\/g, '/');
    for (const match of markdown.match(CODE_SHAPE) ?? []) {
      if (!codes.has(match)) violations.push(`${where}: documents "${match}", which is not in ERROR_CODES`);
    }
    for (const sentence of markdown.split(/(?<=[.!?])\s+|\n{2,}|\n[-|>#]/)) {
      if (ISOLATION_TERMS.test(sentence) && !NEGATIONS.test(sentence)) {
        violations.push(`${where}: "${sentence.trim().slice(0, 90)}…" uses isolation wording without denying the guarantee (D03)`);
      }
    }
    for (const pattern of KEY_ENTRY_CLAIMS) {
      if (pattern.test(markdown)) violations.push(`${where}: instructs a reader to type an API key into the interface`);
    }
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkDocErrorCodes(process.cwd());
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('Documented error codes exist, and no doc claims isolation or key entry.');
}
