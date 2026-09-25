import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRIPT_DEPENDENCY_SET } from '../execution/dependency-policy';
import { renderCodeContract } from '@automate/core';

const source = path.resolve(import.meta.dirname, '..');
const fixtures = path.resolve(import.meta.dirname, 'fixtures/runtime');

function failures(text: string, file: string): string[] {
  const findings: string[] = [];
  if (/shell\s*:\s*true/.test(text)) findings.push('shell');
  if (/\b(?:exec|execSync)\s*[,}]\s*from\s*['"]node:child_process/.test(text)) findings.push('exec');
  if (file !== 'dependency-policy.ts' && /\[\s*['"](?:run|sync|lock)['"]\s*,/.test(text)) findings.push('inline uv');
  if (/from\s*['"][^'"]*(?:agent\/|assemblePromptContext)/.test(text)) findings.push('agent import');
  return findings;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []);
}

describe('execution boundaries', () => {
  it('keeps shell and inline uv argument vectors out of execution and verification', () => {
    for (const dir of ['execution', 'verification']) for (const file of files(path.join(source, dir))) expect(failures(readFileSync(file, 'utf8'), path.basename(file)), file).toEqual([]);
  });

  it('proves the source scan catches unsafe examples', () => {
    expect(failures(readFileSync(path.join(fixtures, 'unsafe-shell.fixture'), 'utf8'), 'unsafe-shell.fixture')).toContain('shell');
    expect(failures(readFileSync(path.join(fixtures, 'unsafe-exec.fixture'), 'utf8'), 'unsafe-exec.fixture')).toContain('exec');
    expect(failures(readFileSync(path.join(fixtures, 'unsafe-uv.fixture'), 'utf8'), 'unsafe-uv.fixture')).toContain('inline uv');
  });

  it('tells generated code its fixed imports and Python-only contract', () => {
    const contract = renderCodeContract({ platform: 'win32', pythonVersion: '3.14.6', dependencies: SCRIPT_DEPENDENCY_SET.map(({ name }) => name), inputFiles: [], attemptLimit: 3 });
    for (const { name } of SCRIPT_DEPENDENCY_SET) expect(contract).toContain(name);
    expect(contract.toLowerCase()).toContain('python');
    expect(contract.toLowerCase()).toContain('shell');
  });
});
