import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const utility = /(?:^|\s)(?:bg-|text-|p[trblxy]?-|m[trblxy]?-|flex(?:-|\b)|grid(?:-|\b)|border(?:-|\b)|rounded(?:-|\b)|gap-)/;

/** Check component className literals. @param root Source directory. @returns File and line violations; token definitions are excluded. */
export function checkDesignTokens(root) {
  const violations = [];
  /** Scan one directory, adding any violations to the enclosing result. */
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'design-system') continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.name.endsWith('.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      const pattern = /className\s*=\s*["']([^"']*)["']/g;
      for (const match of source.matchAll(pattern)) {
        if (utility.test(match[1])) {
          const line = source.slice(0, match.index).split('\n').length;
          violations.push(`${relative(root, file)}:${line}: raw utility in className`);
        }
      }
    }
  }
  visit(root);
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('..', import.meta.url)), 'src');
  const violations = checkDesignTokens(root);
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('Components use semantic design tokens.');
}
