import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check README pnpm commands. @param root Repository root. @returns Commands without a matching built-in or package script. */
export function checkReadmeCommands(root) {
  const markdown = readFileSync(join(root, 'README.md'), 'utf8');
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const builtins = new Set(['install', 'add', 'exec', 'dlx', 'audit']);
  const violations = [];
  const inline = [...markdown.matchAll(/`(pnpm\s+[^`\n]+)`/g)].map((match) => match[1]);
  const fenced = markdown.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^pnpm\s/.test(line));
  for (const quoted of [...inline, ...fenced]) {
    const parts = quoted.split(/\s+/);
    let manifest = rootPackage;
    let command = parts[1];
    if (command === '--filter') {
      const name = parts[2]?.replace('@automate/', '');
      if (!name || !['core', 'server', 'web'].includes(name)) { violations.push(`${quoted}: unknown package`); continue; }
      manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
      command = parts[3];
    }
    if (!command || (!builtins.has(command) && !(command in (manifest.scripts ?? {})))) violations.push(`${quoted}: missing script`);
  }
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkReadmeCommands(process.cwd());
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('README commands are available.');
}
