import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_UV_ARGS, LOCKED_COMMANDS, PINNED_PYTHON_VERSION, SCRIPT_DEPENDENCY_SET, VERIFICATION_TOOL_SET, describeDependencySet, renderPyproject } from '../../execution/dependency-policy';

const runtime = path.resolve(import.meta.dirname, '../../../runtime');

describe('repository-owned dependency policy', () => {
  it.each([['script-env', SCRIPT_DEPENDENCY_SET], ['verify-env', VERIFICATION_TOOL_SET]] as const)('commits exact %s manifests', (kind, set) => {
    const dir = path.join(runtime, kind);
    const spec = readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
    const lock = readFileSync(path.join(dir, 'uv.lock'), 'utf8');
    expect(spec).toBe(renderPyproject(set));
    expect(readFileSync(path.join(dir, '.python-version'), 'utf8').trim()).toBe(PINNED_PYTHON_VERSION);
    expect(lock).toContain(`requires-python = "==${PINNED_PYTHON_VERSION}"`);
    for (const { name, version } of set) {
      expect(spec).toContain(`"${name}==${version}"`);
      expect(lock).toContain(`name = "${name}"\nversion = "${version}"`);
    }
    expect([...spec.matchAll(/"([\w-]+)==[\w.]+"/g)].map((match) => match[1])).toEqual(set.map(({ name }) => name));
  });

  it('builds only locked runtime commands', () => {
    const project = 'C:/env';
    expect(LOCKED_COMMANDS.probe()).toEqual(['--version']);
    expect(LOCKED_COMMANDS.findPython(PINNED_PYTHON_VERSION)).toEqual(['python', 'find', PINNED_PYTHON_VERSION]);
    expect(LOCKED_COMMANDS.installPython(PINNED_PYTHON_VERSION)).toEqual(['python', 'install', PINNED_PYTHON_VERSION]);
    expect(LOCKED_COMMANDS.prepare(project)).toEqual(['sync', '--locked', '--project', project]);
    expect(LOCKED_COMMANDS.runScript(project, 'C:/env/automate_launch.py', 'main.py')).toEqual(['run', '--project', project, '--no-sync', '--locked', '--', 'python', 'C:/env/automate_launch.py', 'main.py']);
    expect(LOCKED_COMMANDS.runTests(project)).toEqual(['run', '--project', project, '--no-sync', '--locked', '--', 'python', '-m', 'pytest', '-q']);
    expect(LOCKED_COMMANDS.runChecker(project, 'ruff', ['check', '--isolated'])).toEqual(['run', '--project', project, '--no-sync', '--locked', '--', 'ruff', 'check', '--isolated']);
    for (const args of [LOCKED_COMMANDS.prepare(project), LOCKED_COMMANDS.runScript(project, 'launcher', 'main.py'), LOCKED_COMMANDS.runTests(project), LOCKED_COMMANDS.runChecker(project, 'bandit', [])]) {
      expect(args).toContain('--locked');
      expect(args).not.toContain('lock');
      for (const forbidden of FORBIDDEN_UV_ARGS) expect(args).not.toContain(forbidden);
    }
  });

  it('documents every approved script package', () => {
    for (const { name, version } of SCRIPT_DEPENDENCY_SET) expect(describeDependencySet()).toContain(`${name} ${version}`);
  });
});
