import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Check one manifest. @param manifest Parsed package.json object. @param label File label. @returns Nonexact dependency violations. */
export function checkManifest(manifest, label = 'package.json') {
  const violations = [];
  for (const block of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[block] ?? {})) {
      if (typeof version !== 'string' || (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) && version !== 'workspace:*')) {
        violations.push(`${label}: ${name} uses ${version}`);
      }
    }
  }
  return violations;
}

/** Inspect workspace manifests. @param root Repository root. @returns Nonexact dependency violations. Installed packages are excluded. */
export function checkWorkspace(root) {
  const files = [join(root, 'package.json')];
  const packages = join(root, 'packages');
  for (const name of readdirSync(packages, { withFileTypes: true })) {
    if (name.isDirectory()) files.push(join(packages, name.name, 'package.json'));
  }
  return files.flatMap((file) => checkManifest(JSON.parse(readFileSync(file, 'utf8')), file));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const violations = checkWorkspace(process.cwd());
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else console.log('All dependency pins are exact.');
}
