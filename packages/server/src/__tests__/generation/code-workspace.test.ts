import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { CodeTooLargeError, CodeVersionImmutableError, InvalidCodePathError, computeVersionDigest } from '@automate/core';
import { CodeWorkspace } from '../../generation/code-workspace';
import { CodeVersionRepository } from '../../db/repositories/code-version-repository';
import { GenerationAttemptRepository } from '../../db/repositories/generation-attempt-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';

let store: TempStore;
let executionId: number;
let versions: CodeVersionRepository;
let attempts: GenerationAttemptRepository;
let workspace: CodeWorkspace;
beforeEach(() => {
  store = createTempStore('automate-workspace-');
  executionId = new TaskRepository(store.connection).createWithExecution('Summarize').execution.id;
  versions = new CodeVersionRepository(store.connection);
  attempts = new GenerationAttemptRepository(store.connection);
  workspace = new CodeWorkspace({ versions, attempts, paths: store.paths, logger: pino({ level: 'silent' }) });
});
afterEach(() => store.dispose());

const attemptDir = (n: number) => path.join(store.paths.scriptsDir, String(executionId), `attempt-${n}`);
const count = (table: string) => (store.connection.client.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
const MAIN = 'import pandas as pd\n\ndef main():\n    print("Zoë — ok")\n';
const TEST = 'from main import main\n\ndef test_main():\n    main()\n';

describe('CodeWorkspace', () => {
  it('keeps one row per path in a draft — a second write replaces the first — and two paths make two rows', () => {
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: 'v1' });
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: 'v2' });
    const draft = versions.findDraft(executionId)!;
    expect(versions.listFiles([draft.id]).map(({ content }) => content)).toEqual(['v2']);
    workspace.putFile(executionId, { path: 'test_main.py', role: 'test', content: TEST });
    expect(versions.listFiles([draft.id])).toHaveLength(2);
    expect(draft.attempt).toBe(1);
  });

  it('rejects an oversized file naming both sizes, and writes nothing — not even a draft', () => {
    const error = (() => { try { workspace.putFile(executionId, { path: 'main.py', role: 'script', content: 'x'.repeat(300 * 1024) }); } catch (cause) { return cause; } return null; })();
    expect(error).toBeInstanceOf(CodeTooLargeError);
    expect((error as Error).message).toContain('307,200');
    expect((error as Error).message).toContain('262,144');
    expect(count('code_version')).toBe(0);
    expect(count('code_file')).toBe(0);
  });

  it.each(['../../evil.py', '/abs.py', 'main.txt', 'output/x.py'])('rejects %j as an invalid path and writes nothing', (bad) => {
    expect(() => workspace.putFile(executionId, { path: bad, role: 'script', content: 'x' })).toThrow(InvalidCodePathError);
    expect(count('code_version')).toBe(0);
  });

  it('seals by projecting byte-identical files from the rows, with an empty output directory and the core digest', () => {
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: MAIN });
    workspace.putFile(executionId, { path: 'lib/helpers.py', role: 'script', content: 'X = 1\n' });
    workspace.putFile(executionId, { path: 'test_main.py', role: 'test', content: TEST });
    const sealed = workspace.seal(executionId);
    expect(sealed.status).toBe('sealed');
    for (const file of sealed.files) expect(readFileSync(path.join(attemptDir(1), ...file.path.split('/')), 'utf8')).toBe(file.content);
    expect(readdirSync(path.join(attemptDir(1), 'output'))).toEqual([]);
    expect(sealed.contentDigest).toBe(computeVersionDigest(sealed.files));
    const fromDisk = sealed.files.map(({ path: file }) => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(attemptDir(1), ...file.split('/')))).digest('hex') }));
    expect(computeVersionDigest(fromDisk)).toBe(sealed.contentDigest);
  });

  it('refuses to seal when there is no draft or the draft is empty, and refuses writes to a sealed version', () => {
    expect(() => workspace.seal(executionId)).toThrow(/no new code to test/);
    workspace.currentDraft(executionId);
    expect(() => workspace.seal(executionId)).toThrow(/no files cannot be sealed/);
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: MAIN });
    const sealed = workspace.seal(executionId);
    expect(() => versions.putFile(sealed.id, { path: 'main.py', role: 'script', content: 'changed' })).toThrow(CodeVersionImmutableError);
  });

  it('seals a second attempt into its own directory and leaves the first untouched on disk', () => {
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: 'first\n' });
    workspace.seal(executionId);
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: 'second\n' });
    const second = workspace.seal(executionId);
    expect(second.attempt).toBe(2);
    expect(readFileSync(path.join(attemptDir(1), 'main.py'), 'utf8')).toBe('first\n');
    expect(readFileSync(path.join(attemptDir(2), 'main.py'), 'utf8')).toBe('second\n');
  });

  it('re-projects identical bytes after a crash removed the directory — the database is authoritative', () => {
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: MAIN });
    const sealed = workspace.seal(executionId);
    const before = readFileSync(path.join(attemptDir(1), 'main.py'));
    rmSync(attemptDir(1), { recursive: true, force: true });
    expect(workspace.project(sealed.id)).toBe(attemptDir(1));
    expect(readFileSync(path.join(attemptDir(1), 'main.py')).equals(before)).toBe(true);
    expect(existsSync(path.join(attemptDir(1), 'output'))).toBe(true);
  });

  it('moves a draft past an attempt number a refusal already used before sealing it', () => {
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: MAIN });
    attempts.refuse({ executionId, attempt: 1, callId: null, reason: 'runtime_unavailable' });
    const sealed = workspace.seal(executionId);
    expect(sealed.attempt).toBe(2);
    expect(existsSync(path.join(attemptDir(2), 'main.py'))).toBe(true);
  });

  it('finalizes with the declared contracts and allows exactly one final version', () => {
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: MAIN });
    const first = workspace.seal(executionId);
    workspace.putFile(executionId, { path: 'main.py', role: 'script', content: 'again' });
    const second = workspace.seal(executionId);
    const details = { entrypoint: 'main.py', summary: 'Totals by region', declaredInputs: [{ fileRole: 'sales.csv', requiredColumns: [{ name: 'region', type: 'string' as const }] }], declaredOutputs: [{ filename: 'totals.csv', type: 'csv' as const, title: 'Totals', description: 'Per region' }] };
    expect(workspace.finalize(first.id, details)).toMatchObject({ isFinal: true, entrypoint: 'main.py' });
    expect(() => workspace.finalize(second.id, details)).toThrow();
    const described = workspace.describe(first.id);
    expect(described).toMatchObject({ isFinal: true, declaredInputs: details.declaredInputs, declaredOutputs: details.declaredOutputs });
    expect(described.files[0]).toMatchObject({ path: 'main.py', content: MAIN, lineCount: 4 });
  });
});
