import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersionDigest, type ConversationEvent } from '@automate/core';
import type { FakeAgentStep } from '../agent/testing/fake-agent-provider';
import { createGenerationHarness, finalizeStep, writeSteps, MAIN_PY, type GenerationHarness, type HarnessOptions } from './support/generation-harness';
import { HIGH_CARDINALITY_SENTINEL, ROW_11_SENTINEL, TRACEBACK_SENTINEL, sentinelCsv } from './support/generation-fixtures';
import { fakeSpawn } from './execution/fake-spawn';
import { lockedUvRunner } from './support/locked-uv-runner';

const harnesses: GenerationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });
async function harness(options: HarnessOptions) {
  const created = await createGenerationHarness(options);
  harnesses.push(created);
  return created;
}
const RUN: FakeAgentStep = { call: { tool: 'run_tests', args: {} } };
const SENTINELS = [ROW_11_SENTINEL, HIGH_CARDINALITY_SENTINEL, TRACEBACK_SENTINEL];
const TRACEBACK = ['Traceback (most recent call last):', '  File "/home/person/.automate/scripts/1/attempt-1/main.py", line 5, in main', `    frame["${TRACEBACK_SENTINEL}"]`, `KeyError: '${TRACEBACK_SENTINEL}'`, `debug print ${TRACEBACK_SENTINEL}`, '1 failed, 2 passed in 0.12s'].join('\n');
const FAILED = { result: { outcome: 'failed' as const, exitCode: 1, stdout: TRACEBACK, stderr: `stderr ${TRACEBACK_SENTINEL}` } };
const EXHAUSTING = (input: string) => Array.from({ length: 3 }, (_, index) => [...writeSteps(input, `${MAIN_PY}# ${index}\n`), RUN]).flat();

/** Every file under a directory, recursively. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(root, entry.name)) : [path.join(root, entry.name)]));
}
function count(h: GenerationHarness, sql: string, ...params: number[]): number {
  return (h.store.connection.client.prepare(sql).get(...params) as { count: number }).count;
}

describe('generation end to end', () => {
  it('writes, fails, repairs, passes, and finalizes — and no sentinel reaches any prompt, event, receipt, tool result, or file', async () => {
    const h = await harness({ pythonRuns: [FAILED, {}], steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, ...writeSteps(upload!.storedFilename, `${MAIN_PY}# repaired\n`), RUN, finalizeStep(upload!.storedFilename)] });
    const row = await h.run();
    expect(row.status).toBe('completed');
    const session = h.provider.sessions[0]!;
    const receipts = h.repos.transmissions.listByExecution(h.execution.id);
    const events = (h.store.connection.client.prepare('SELECT payload FROM conversation_event').all() as { payload: string }[]).map(({ payload }) => payload);
    const files = filesUnder(h.store.paths.scriptsDir).map((file) => readFileSync(file));
    const everything = [session.prompts.join('\n'), JSON.stringify(session.toolResults), events.join('\n'), JSON.stringify(receipts)].join('\n');
    for (const sentinel of SENTINELS) {
      expect(everything).not.toContain(sentinel);
      for (const bytes of files) expect(bytes.includes(sentinel)).toBe(false);
    }
    expect(Buffer.from(sentinelCsv()).includes(ROW_11_SENTINEL)).toBe(true);
    expect(session.prompts[0]).toContain(`[APPROVED FILE DESCRIPTION]\n${h.consent!.payloadSnapshot}\n\n[APPLICATION CONTEXT]`);
    expect(receipts.map(({ kind }) => kind)).toEqual(['context', 'diagnostics']);
    expect(count(h, 'SELECT count(*) AS count FROM code_version WHERE execution_id = ? AND is_final = 1', h.execution.id)).toBe(1);
  });

  it('binds the final version\'s digest to its stored rows and to the bytes on disk', async () => {
    const h = await harness({ pythonRuns: [FAILED, {}], steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, ...writeSteps(upload!.storedFilename, `${MAIN_PY}# repaired\n`), RUN, finalizeStep(upload!.storedFilename)] });
    await h.run();
    const final = h.repos.versions.findFinal(h.execution.id)!;
    const rows = h.repos.versions.listFiles([final.id]);
    expect(computeVersionDigest(rows)).toBe(final.contentDigest);
    const dir = h.workspace.attemptDir(final);
    expect(computeVersionDigest(rows.map(({ path: file }) => ({ path: file, sha256: createHash('sha256').update(readFileSync(path.join(dir, ...file.split('/')))).digest('hex') })))).toBe(final.contentDigest);
  });

  it('replays the transcript from seq 1 gap-free with every kind in order', async () => {
    const h = await harness({ pythonRuns: [FAILED, {}], steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, ...writeSteps(upload!.storedFilename, `${MAIN_PY}# repaired\n`), RUN, finalizeStep(upload!.storedFilename)] });
    await h.run();
    const events = h.transcript();
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    const kinds = events.map(({ type }) => type);
    const first = (kind: ConversationEvent['type']) => kinds.indexOf(kind);
    expect(kinds.slice(0, 3)).toEqual(['state_changed', 'user_prompt', 'disclosure_sent']);
    expect(first('tool_started')).toBeLessThan(first('code_version_sealed'));
    expect(first('code_version_sealed')).toBeLessThan(first('test_run_finished'));
    expect(kinds.filter((kind) => kind === 'code_version_sealed')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'test_run_finished')).toHaveLength(2);
    expect(kinds.slice(-2)).toEqual(['generation_settled', 'state_changed']);
    expect(events.filter((event) => event.type === 'disclosure_sent').map((event) => (event as { kind: string }).kind)).toEqual(['context', 'diagnostics']);
  });

  it('settles failed with GENERATION_ATTEMPTS_EXHAUSTED after three failures, keeping three sealed versions and no final one', async () => {
    const h = await harness({ pythonRuns: [FAILED, FAILED, FAILED], steps: (upload) => EXHAUSTING(upload!.storedFilename) });
    const row = await h.run();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'GENERATION_ATTEMPTS_EXHAUSTED', errorMessage: "This run used all 3 attempts without getting the tests to pass. Tell me what went wrong and I'll try again." });
    expect(h.repos.versions.listByExecution(h.execution.id).map(({ status }) => status)).toEqual(['tested_fail', 'tested_fail', 'tested_fail']);
    expect(h.repos.versions.findFinal(h.execution.id)).toBeUndefined();
    const attempts = h.service.listAttempts(h.execution.id);
    expect(attempts).toHaveLength(3);
    expect(attempts.every(({ diagnostics }) => diagnostics !== null)).toBe(true);
    expect(h.transcript().find(({ type }) => type === 'generation_settled')).toMatchObject({ outcome: 'exhausted', attemptsUsed: 3, summary: expect.stringMatching(/^Used all 3 attempts without getting the tests to pass\./) });
  });

  it('stops at the first run when the diagnostics scope was not granted, with no second attempt', async () => {
    const h = await harness({ scopeDiagnostics: false, steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, ...writeSteps(upload!.storedFilename), RUN] });
    const row = await h.run();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'DISCLOSURE_SCOPE_NOT_GRANTED' });
    expect(h.repos.attempts.countUsed(h.execution.id)).toBe(0);
    expect(h.repos.attempts.listByExecution(h.execution.id).every(({ refusalReason }) => refusalReason === 'diagnostics_not_granted')).toBe(true);
    expect(h.repos.transmissions.listByExecution(h.execution.id).map(({ kind }) => kind)).toEqual(['context']);
  });

  it('refuses honestly with the install hint when uv is unavailable', async () => {
    const h = await harness({ runner: (paths, connection) => lockedUvRunner(paths, connection, () => ({ error: new Error('spawn uv ENOENT') })).runner, steps: (upload) => [...writeSteps(upload!.storedFilename), RUN] });
    const row = await h.run();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'PYTHON_RUNTIME_UNAVAILABLE' });
    expect(row.errorMessage).toContain('uv or Python 3.11 or newer is not available');
    expect(row.errorMessage).toContain('uv python install 3.14.6');
    expect(JSON.stringify(h.provider.sessions[0]!.toolResults)).toContain('winget install astral-sh.uv');
  });

  it('kills the pytest process tree on abort, settling the attempt and the execution aborted', async () => {
    let fake!: ReturnType<typeof fakeSpawn>;
    const h = await harness({
      runner: (paths, connection) => { const built = lockedUvRunner(paths, connection, (_, args) => (args[0] === '--version' ? { stdout: 'uv 0.11.32\n' } : args[0] === 'run' ? { hang: true } : { exitCode: 0 })); fake = built.fake; return built.runner; },
      steps: (upload) => [...writeSteps(upload!.storedFilename), RUN],
    });
    writeFileSync(path.join(h.store.paths.envDir, 'uv.lock'), 'lock');
    const settled = h.run();
    for (let tries = 0; tries < 500 && !fake.calls.some(({ args }) => args.includes('pytest')); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await h.registry.abort(h.execution.id);
    expect((await settled).status).toBe('aborted');
    const pytest = fake.calls.find(({ args }) => args.includes('pytest'))!;
    expect(fake.calls.some(({ command, args }) => command === 'taskkill' && args[1] === String(pytest.pid))).toBe(true);
    expect(h.repos.attempts.listByExecution(h.execution.id)).toMatchObject([{ status: 'aborted' }]);
  });

  it('retries with guidance as a new run that reuses the consent, seeds prior answers, and carries the guidance in its prompt', async () => {
    const dates = ['order_id,when,amount', ...Array.from({ length: 30 }, (_, index) => `${index + 1},0${(index % 9) + 1}/0${(index % 3) + 1}/2026,${index}.5`)].join('\n');
    const h = await harness({ files: [{ name: 'orders.csv', bytes: Buffer.from(`${dates}\n`), format: 'csv' }], pythonRuns: [FAILED, FAILED, FAILED, {}], steps: (upload) => EXHAUSTING(upload!.storedFilename) });
    const required = h.disclosure.buildPreview(h.uploads.map(({ id }) => id)).required;
    expect(required.length).toBeGreaterThan(0);
    h.preflight.persist(h.execution.id, h.preflight.resolveDecisions(h.uploads.map(({ id }) => id), required.map((finding) => ({ findingKey: finding.findingKey, choice: finding.options[0]!.value }))));
    expect((await h.run())).toMatchObject({ status: 'failed', errorCode: 'GENERATION_ATTEMPTS_EXHAUSTED' });
    h.provider.enqueue([{ events: [], steps: [...writeSteps(h.upload!.storedFilename), RUN, finalizeStep(h.upload!.storedFilename, { declaredInputs: [] })], result: { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } } }]);
    const consents = count(h, 'SELECT count(*) AS count FROM disclosure_consent');
    const created = h.service.retry(h.execution.id, 'The dates are day first.');
    const retry = await h.registry.get(created.execution.id)!.settled;
    expect(retry).toMatchObject({ status: 'completed', retryOfExecutionId: h.execution.id, trigger: 'rerun' });
    expect(count(h, 'SELECT count(*) AS count FROM disclosure_consent')).toBe(consents);
    const seeded = h.repos.clarifications.listByExecution(retry.id).flatMap(({ questions }) => questions);
    expect(seeded.length).toBe(required.length);
    expect(seeded.every(({ answerSource }) => answerSource === 'seeded')).toBe(true);
    const prompt = h.provider.sessions[1]!.prompts[0]!;
    expect(prompt).toContain('The dates are day first.');
    expect(prompt).toContain(seeded[0]!.promptText);
    expect(h.repos.transmissions.listByExecution(retry.id).map(({ kind }) => kind)).toEqual(['context']);
  });

  it('materializes two fixtures, with the real files\' names and formats, under one context transmission', async () => {
    const h = await harness({ files: [{ name: 'sales.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' }, { name: 'more.csv', bytes: Buffer.from('a,b\n1,x\n2,y\n'), format: 'csv' }], steps: () => [] });
    await h.run();
    const fixtures = h.repos.fixtures.listByExecution(h.execution.id);
    expect(fixtures.map(({ filePath }) => filePath.split('/').pop()).sort()).toEqual(h.uploads.map(({ storedFilename }) => storedFilename).sort());
    expect(fixtures.every(({ format }) => format === 'csv')).toBe(true);
    expect(h.repos.transmissions.listByExecution(h.execution.id).map(({ kind }) => kind)).toEqual(['context']);
  });

  it('produces byte-identical fixtures when the same execution materializes again', async () => {
    const h = await harness({ steps: () => [] });
    await h.run();
    const before = h.repos.fixtures.listByExecution(h.execution.id)[0]!;
    const [again] = await h.fixtureService.materializeFixtures(h.execution.id, h.uploads.map(({ id }) => id), new AbortController().signal);
    expect(again!.sha256).toBe(before.sha256);
  });

  it('leaves only scripts/{executionId}/ behind, and deleting the task leaves no orphaned rows', async () => {
    const h = await harness({ pythonRuns: [{}], steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename)] });
    const snapshot = () => filesUnder(h.store.root).filter((file) => !file.includes(`${path.sep}data${path.sep}`)).map((file) => path.relative(h.store.root, file));
    const before = new Set(snapshot());
    await h.run();
    const added = snapshot().filter((file) => !before.has(file));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((file) => file.startsWith(path.join('scripts', String(h.execution.id)) + path.sep))).toBe(true);
    h.store.connection.client.prepare('DELETE FROM task WHERE id = ?').run(h.task.id);
    expect(h.store.connection.client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    for (const table of ['code_version', 'code_file', 'generation_attempt', 'synthetic_fixture']) expect(count(h, `SELECT count(*) AS count FROM ${table}`)).toBe(0);
  });
});

describe('generation static guards', () => {
  const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const coreGeneration = path.resolve(serverSrc, '../../core/src/generation');
  const productionFiles = (dir: string) => filesUnder(dir).filter((file) => file.endsWith('.ts') && !file.includes(`${path.sep}testing${path.sep}`));

  /** A generation-phase module that could reach an upload's stored bytes: the file store, the uploads directory, or an upload row's stored path. */
  function uploadPathReaches(source: string): string[] {
    const patterns = [/\bUploadFileStore\b/, /\buploadsDir(?:ForTask)?\b/, /\bstagedPathFor\b|\btaskPathFor\b/, /\bupload\w*\.filePath\b/, /\breadFile(?:Sync)?\(\s*upload/];
    return source.split('\n').filter((line) => patterns.some((pattern) => pattern.test(line)));
  }

  it('no generation or execution module resolves an upload\'s stored path — except FEAT-107\'s input stager', () => {
    // FEAT-107: `execution/input-stager.ts` is the ONE sanctioned reader of an upload's bytes. It copies them
    // for an approved real run and never builds a prompt; only the script-run service may import it.
    const stager = path.join(serverSrc, 'execution', 'input-stager.ts');
    for (const file of [...productionFiles(path.join(serverSrc, 'generation')), ...productionFiles(path.join(serverSrc, 'execution'))].filter((item) => item !== stager)) expect(uploadPathReaches(readFileSync(file, 'utf8')), file).toEqual([]);
    expect(uploadPathReaches(readFileSync(stager, 'utf8'))).not.toEqual([]);
    const importers = productionFiles(serverSrc).filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`) && /from '[./]+(?:execution\/)?input-stager'/.test(readFileSync(file, 'utf8')));
    expect(importers.map((file) => path.relative(serverSrc, file).replace(/\\/g, '/'))).toEqual(['execution/script-run-service.ts']);
  });

  it('fails when a deliberate readFile(upload.filePath) is added to the generation path', () => {
    const source = readFileSync(path.join(serverSrc, 'generation', 'fixture-service.ts'), 'utf8');
    expect(uploadPathReaches(`${source}\nconst leaked = readFileSync(upload.filePath);`)).not.toEqual([]);
  });

  it('keeps packages/core/src/generation free of Node built-ins', () => {
    for (const file of productionFiles(coreGeneration)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from ['"]node:/);
    expect(statSync(coreGeneration).isDirectory()).toBe(true);
  });
});
