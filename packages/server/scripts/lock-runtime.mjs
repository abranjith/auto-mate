import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const here = path.dirname(fileURLToPath(import.meta.url));
const policy = await tsImport('../src/execution/dependency-policy.ts', import.meta.url);
for (const [kind, set] of [['script-env', policy.SCRIPT_DEPENDENCY_SET], ['verify-env', policy.VERIFICATION_TOOL_SET]]) {
  const project = path.resolve(here, '..', 'runtime', kind);
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, '.python-version'), `${policy.PINNED_PYTHON_VERSION}\n`);
  writeFileSync(path.join(project, 'pyproject.toml'), policy.renderPyproject(set));
  execFileSync('uv', ['lock', '--project', project], { stdio: 'inherit' });
  const lock = readFileSync(path.join(project, 'uv.lock'), 'utf8');
  if (!lock.includes(`requires-python = "==${policy.PINNED_PYTHON_VERSION}"`)) throw new Error(`${kind}: interpreter pin missing from lock`);
  for (const { name, version } of set) {
    if (!lock.includes(`name = "${name}"\nversion = "${version}"`)) throw new Error(`${kind}: ${name} ${version} missing from lock`);
  }
  process.stdout.write(`${kind}: ${set.map(({ name, version }) => `${name} ${version}`).join(', ')}\n`);
}
