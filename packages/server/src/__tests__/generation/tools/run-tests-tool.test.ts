import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PythonRuntimeUnavailableError } from '@automate/core';
import { parsePytestReport } from '../../../generation/pytest-report';
import { PYTEST_ARGS, RunTestsExecutor } from '../../../generation/tools/run-tests-tool';
import { GenerationBudget } from '../../../generation/generation-budget';
import { GenerationRun } from '../../../generation/generation-run';
import type { FakePythonRunner } from '../../../execution/testing/fake-python-runner';
import { createGenerationHarness, writeSteps, type GenerationHarness, type HarnessOptions } from '../../support/generation-harness';
import { TRACEBACK_SENTINEL } from '../../support/generation-fixtures';
import type { FakeAgentStep } from '../../../agent/testing/fake-agent-provider';

const harnesses: GenerationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });
async function harness(options: HarnessOptions) {
  const created = await createGenerationHarness(options);
  harnesses.push(created);
  return created;
}
const RUN: FakeAgentStep = { call: { tool: 'run_tests', args: {} } };
const cycle = (input: string) => [...writeSteps(input), RUN];
const details = (output: unknown) => (output as { details: Record<string, unknown> }).details;
const RAW_FAILURE = [
  '.F.',
  'FAILED test_main.py::test_main_runs - KeyError: \'' + TRACEBACK_SENTINEL + '\'',
  'Traceback (most recent call last):',
  '  File "/home/person/.automate/scripts/1/attempt-1/main.py", line 5, in main',
  '    total = frame["' + TRACEBACK_SENTINEL + '"]',
  'KeyError: \'' + TRACEBACK_SENTINEL + '\'',
  'print-debug: customer=' + TRACEBACK_SENTINEL,
  '1 failed, 2 passed in 0.12s',
].join('\n');
const FAILED = { result: { outcome: 'failed' as const, exitCode: 1, stdout: RAW_FAILURE, stderr: `warning ${TRACEBACK_SENTINEL}` } };

describe('run_tests', () => {
  it('settles a passing run with its counts, marks the version passed, and sends no diagnostics', async () => {
    const h = await harness({ pythonRuns: [{ result: { stdout: '...\n3 passed in 0.10s\n' } }], steps: (upload) => cycle(upload!.storedFilename) });
    await h.run();
    const [attempt] = h.repos.attempts.listByExecution(h.execution.id);
    expect(attempt).toMatchObject({ status: 'passed', testsTotal: 3, testsPassed: 3, testsFailed: 0, exitCode: 0, diagnosticDigest: null, droppedLineCount: null, callId: expect.any(String) });
    expect(h.repos.versions.getById(attempt!.codeVersionId!)).toMatchObject({ status: 'tested_pass', testsPassed: true });
    expect(h.repos.transmissions.listByExecution(h.execution.id).map(({ kind }) => kind)).toEqual(['context']);
    const result = details(h.provider.sessions[0]!.toolResults.find(({ tool }) => tool === 'run_tests')!.output);
    expect(result).toMatchObject({ outcome: 'passed', testsTotal: 3, testsPassed: 3, testsFailed: 0, diagnostics: null, attemptsRemaining: 2, manifestPresent: false });
  });

  it('runs pytest in the sealed attempt directory against the fixtures, writing to the attempt\'s scratch output', async () => {
    const h = await harness({ steps: (upload) => cycle(upload!.storedFilename) });
    await h.run();
    const request = (h.runner as FakePythonRunner).requests[0]!;
    const version = h.repos.versions.listByExecution(h.execution.id)[0]!;
    expect(request.args).toEqual(PYTEST_ARGS);
    expect(request.workingDir).toBe(h.workspace.attemptDir(version));
    expect(request.env).toEqual({ AUTOMATE_INPUT_DIR: h.fixtureService.fixturesDir(h.execution.id), AUTOMATE_OUTPUT_DIR: h.workspace.outputDir(version) });
    expect(readFileSync(path.join(request.workingDir, 'main.py'), 'utf8')).toContain('pandas');
  });

  it('filters a failure through FEAT-105, records the diagnostics transmission, and returns only the filtered text (the central test)', async () => {
    const h = await harness({ pythonRuns: [FAILED], steps: (upload) => cycle(upload!.storedFilename) });
    await h.run();
    const receipts = h.repos.transmissions.listByExecution(h.execution.id);
    expect(receipts.map(({ kind }) => kind)).toEqual(['context', 'diagnostics']);
    const result = details(h.provider.sessions[0]!.toolResults.find(({ tool }) => tool === 'run_tests')!.output);
    expect(result).toMatchObject({ outcome: 'failed', testsTotal: 3, testsPassed: 2, testsFailed: 1, attemptsRemaining: 2 });
    expect(result.diagnostics).toBe(receipts[1]!.payloadSnapshot);
    expect(result.diagnostics).toContain('File "main.py", line 5, in main');
    const [attempt] = h.repos.attempts.listByExecution(h.execution.id);
    expect(attempt!.diagnosticDigest).toBe(receipts[1]!.payloadDigest);
    expect(attempt!.droppedLineCount).toBeGreaterThan(0);
    const everything = JSON.stringify([h.provider.sessions[0]!.toolResults, h.repos.attempts.listByExecution(h.execution.id), h.transcript(), receipts]) + h.provider.sessions[0]!.prompts.join('\n');
    expect(everything).not.toContain(TRACEBACK_SENTINEL);
    expect(everything).not.toContain('/home/person');
  });

  it.each([1, 3])('refuses the call past a cap of %i: records it, seals nothing, never touches the runner, and says to finalize', async (cap) => {
    const runs = Array.from({ length: cap }, () => FAILED);
    const h = await harness({ limits: { maxAttempts: cap }, pythonRuns: runs, steps: (upload) => [...Array.from({ length: cap }, () => cycle(upload!.storedFilename)).flat(), ...writeSteps(upload!.storedFilename), RUN] });
    await h.run();
    const attempts = h.repos.attempts.listByExecution(h.execution.id);
    expect(attempts.map(({ status }) => status)).toEqual([...Array.from({ length: cap }, () => 'failed'), 'refused']);
    expect(attempts.at(-1)).toMatchObject({ refusalReason: 'attempt_limit', codeVersionId: null });
    expect((h.runner as FakePythonRunner).requests).toHaveLength(cap);
    expect(h.repos.versions.listByExecution(h.execution.id).filter(({ status }) => status !== 'draft' && status !== 'superseded')).toHaveLength(cap);
    const refusal = details(h.provider.sessions[0]!.toolResults.at(-1)!.output);
    expect(refusal).toMatchObject({ outcome: 'refused', refusalReason: 'attempt_limit', attemptsRemaining: 0 });
    expect(refusal.message).toContain('finalize_script');
    expect(h.transcript().filter(({ type }) => type === 'test_run_finished').at(-1)).toMatchObject({ outcome: 'refused', refusalReason: 'attempt_limit' });
  });

  it('refuses diagnostics_not_granted before the runner is touched when only the context scope was granted', async () => {
    const h = await harness({ scopeDiagnostics: false, steps: (upload) => cycle(upload!.storedFilename) });
    const row = await h.run();
    const runner = h.runner as FakePythonRunner;
    expect([runner.probeCount, runner.ensureCount, runner.requests.length]).toEqual([0, 0, 0]);
    expect(h.repos.attempts.listByExecution(h.execution.id)).toMatchObject([{ status: 'refused', refusalReason: 'diagnostics_not_granted' }]);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'DISCLOSURE_SCOPE_NOT_GRANTED' });
  });

  it('refuses runtime_unavailable with the install hint when uv is missing', async () => {
    const h = await harness({ runnerOptions: { probeError: new PythonRuntimeUnavailableError('uv', 'winget install astral-sh.uv') }, steps: (upload) => cycle(upload!.storedFilename) });
    const row = await h.run();
    const refusal = details(h.provider.sessions[0]!.toolResults.find(({ tool }) => tool === 'run_tests')!.output);
    expect(refusal).toMatchObject({ outcome: 'refused', refusalReason: 'runtime_unavailable' });
    expect(refusal.message).toContain('winget install astral-sh.uv');
    expect(row).toMatchObject({ status: 'failed', errorCode: 'PYTHON_RUNTIME_UNAVAILABLE' });
  });

  it('settles a timeout as timed_out and still records a filtered diagnostic', async () => {
    const h = await harness({ pythonRuns: [{ result: { outcome: 'timed_out', exitCode: null, stdout: 'collected 3 items\n', stderr: `Traceback (most recent call last):\n  File "main.py", line 2, in <module>\nKeyboardInterrupt: '${TRACEBACK_SENTINEL}'` } }], steps: (upload) => cycle(upload!.storedFilename) });
    await h.run();
    expect(h.repos.attempts.listByExecution(h.execution.id)).toMatchObject([{ status: 'timed_out', diagnosticDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(h.repos.transmissions.listByExecution(h.execution.id).map(({ kind }) => kind)).toEqual(['context', 'diagnostics']);
  });

  it.each([
    ['valid', '{"artifacts": []}', true],
    ['absent', null, false],
    ['malformed', '{"artifacts": [', false],
  ] as const)('records a %s manifest as %s without changing the outcome', async (_name, manifest, expected) => {
    const h = await harness({ pythonRuns: [{ onRun: (request) => { if (manifest !== null) { mkdirSync(request.env.AUTOMATE_OUTPUT_DIR!, { recursive: true }); writeFileSync(path.join(request.env.AUTOMATE_OUTPUT_DIR!, 'manifest.json'), manifest); } } }], steps: (upload) => cycle(upload!.storedFilename) });
    await h.run();
    expect(h.repos.attempts.listByExecution(h.execution.id)).toMatchObject([{ status: 'passed', manifestPresent: expected }]);
  });

  it('surfaces a second run for the same call id as an error rather than opening a second attempt', async () => {
    const h = await harness({ steps: () => [] });
    await h.run();
    const execution = h.repos.executions.createRetry(h.execution.id, null);
    h.repos.executions.markStarted(execution.id);
    h.runs.open(new GenerationRun(execution.id, h.task.id, new GenerationBudget({ executionId: execution.id, attempts: h.repos.attempts, executions: h.repos.executions, limits: h.limits })));
    const executor = new RunTestsExecutor({ workspace: h.workspace, versions: h.repos.versions, attempts: h.repos.attempts, executions: h.repos.executions, runs: h.runs, runner: h.runner, consent: h.disclosure, diagnostics: h.inner, transmissions: h.repos.transmissions, fixturesDir: (id) => h.fixtureService.fixturesDir(id), publish: () => undefined, logger: { info: () => undefined, warn: () => undefined } });
    h.workspace.putFile(execution.id, { path: 'main.py', role: 'script', content: 'a = 1\n' });
    await executor.execute(execution.id, 'same-call');
    h.workspace.putFile(execution.id, { path: 'main.py', role: 'script', content: 'a = 2\n' });
    await expect(executor.execute(execution.id, 'same-call')).rejects.toThrow();
    expect(h.repos.attempts.listByExecution(execution.id)).toHaveLength(1);
  });
});

describe('parsePytestReport', () => {
  it.each([
    ['3 passed in 0.10s', { total: 3, passed: 3, failed: 0, collectionError: false }],
    ['1 failed, 2 passed in 0.12s', { total: 3, passed: 2, failed: 1, collectionError: false }],
    ['==== 1 failed, 1 passed, 1 skipped, 2 warnings in 1.02s ====', { total: 3, passed: 1, failed: 1, collectionError: false }],
    ['ERROR collecting test_main.py\n1 error in 0.20s', { total: 1, passed: 0, failed: 1, collectionError: true }],
    ['Interrupted: 1 error during collection\n1 error in 0.05s', { total: 1, passed: 0, failed: 1, collectionError: true }],
    ['no tests ran in 0.01s', { total: 0, passed: 0, failed: 0, collectionError: false }],
  ])('parses %j', (output, expected) => {
    expect(parsePytestReport(output)).toEqual(expected);
  });

  it.each(['INTERNALERROR> Traceback', '', 'random noise\nmore noise'])('returns null counts for %j without throwing', (output) => {
    expect(parsePytestReport(output)).toMatchObject({ total: null, passed: null, failed: null });
  });

  it('uses the last summary line when output contains more than one', () => {
    expect(parsePytestReport('1 failed in 0.1s\n...\n4 passed in 0.2s')).toMatchObject({ total: 4, passed: 4 });
  });
});

describe('run_tests source guard', () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../generation/tools/run-tests-tool.ts'), 'utf8');

  /** Every line that reads raw process output must be the one allowed line inside `consumeRawOutput`, and `raw` may flow only to local count parsing and FEAT-105's chokepoint. */
  function rawOutputLeaks(text: string): string[] {
    const lines = text.split('\n');
    const leaks = lines.filter((line) => /\.(?:stdout|stderr)\b/.test(line) && !line.includes('const raw = `${result.stdout}\\n${result.stderr}`;'));
    const code = lines.filter((line) => !/^\s*(?:\/\/|\*|\/\*\*)/.test(line));
    const allowed = [/const raw = `\$\{result\.stdout\}\\n\$\{result\.stderr\}`;/, /parsePytestReport\(raw\)/, /recordDiagnosticTransmission\(executionId, raw\)/];
    // Strip each permitted use once; any `raw` still left on a line flows somewhere it must not.
    const rawLeaks = code.filter((line) => /\braw\b/.test(allowed.reduce((rest, pattern) => rest.replace(pattern, ''), line)));
    return [...leaks, ...rawLeaks];
  }

  it('reads raw output in exactly one place and sends it only through recordDiagnosticTransmission', () => {
    expect(rawOutputLeaks(source)).toEqual([]);
    expect(source.match(/\.(?:stdout|stderr)\b/g)).toHaveLength(2);
  });

  it('fails when a deliberate raw-return branch is added', () => {
    expect(rawOutputLeaks(source.replace('    const report = parsePytestReport(raw);', '    if (result.exitCode === 9) return { report: parsePytestReport(raw), filtered: raw };\n    const report = parsePytestReport(raw);'))).not.toEqual([]);
    expect(rawOutputLeaks(`${source}\nexport const leak = (result: PythonRunResult) => result.stderr;`)).not.toEqual([]);
  });
});
