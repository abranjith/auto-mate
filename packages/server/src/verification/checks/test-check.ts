// ---------------------------------------------------------------------------
// The independent test re-run (FEAT-107 TASK-008).
//
// The application runs the agent's pytest tests ITSELF, against a fixture it
// rebuilt itself (the integrity check proved the bytes identical to the ones
// recorded), rather than trusting `generation_attempt.tests_passed` — the
// agent reported that number through a tool it called, and the whole premise
// of this check is not taking the model's word for the model's own work. The
// re-run also produces the RUNTIME-BOUND result: the recorded one predates any
// fingerprint.
//
// `passed` requires a zero exit AND a recognized pytest summary with zero
// failures. An exit code alone is not an answer: a zero exit with no summary
// is `errored`, which blocks.
//
// UNTRUSTED OUTPUT: this check's stdout/stderr are raw bytes from generated
// code that runs WITHOUT an isolation boundary (D03). Nothing here may place
// them in a prompt or a log. Counts and a plain summary reach the UI; the raw
// text is kept on the check's `detail` only as a short head-and-tail excerpt.
// ---------------------------------------------------------------------------

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { TEST_RUN_TIMEOUT_MS, formatDurationMs, type PythonRunResult, type PythonRunner } from '@automate/core';
import { capHeadTail } from '../../execution/output-cap';
import { parsePytestReport } from '../../generation/pytest-report';
import { PYTEST_ARGS } from '../../generation/tools/run-tests-tool';
import { erroredOutcome, plural, resolveFinding, type CheckOutcome } from './check-result';
import type { RebuiltFixtures } from './integrity-check';

/** Bytes of raw output kept on the check's detail, head and tail. */
export const TEST_OUTPUT_EXCERPT_BYTES = 4_096;

export interface TestCheckRequest {
  readonly runner: PythonRunner;
  readonly executionId: number;
  /** The projected, integrity-checked version directory. */
  readonly versionDir: string;
  /** The fixtures the integrity check rebuilt; `AUTOMATE_INPUT_DIR` points at their directory. */
  readonly fixtures: RebuiltFixtures;
  /** `runs/{executionId}/verify/`; scratch output goes in a fresh `output/` inside it and is discarded. */
  readonly verifyDir: string;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
}

/** Why a finished run is not an answer, or null when its counts can be trusted. */
function unusable(result: PythonRunResult, report: ReturnType<typeof parsePytestReport>, timeoutMs: number): string | null {
  if (result.outcome === 'aborted') return 'The test re-run was stopped before it finished (aborted).';
  if (result.outcome === 'timed_out') return `The test re-run took longer than ${formatDurationMs(timeoutMs)} and was stopped, so the tests did not finish.`;
  if (report.collectionError) return 'The tests could not be collected — the test files or the script failed to import.';
  if (report.total === null) return `The test re-run finished (exit code ${result.exitCode ?? 'unknown'}) without a pytest summary this app recognizes, so its result cannot be trusted.`;
  if (report.total === 0) return 'No tests were found to run, so nothing was checked.';
  if (result.outcome === 'errored') return `pytest could not run the tests properly (exit code ${result.exitCode ?? 'unknown'}).`;
  if ((result.outcome === 'passed') !== (report.failed === 0)) return `pytest's exit code (${result.exitCode ?? 'unknown'}) and its summary disagree about whether the tests passed, so neither can be trusted.`;
  return null;
}

/**
 * Re-run the version's pytest tests against the rebuilt fixtures.
 * @returns `passed` only for a zero exit with a recognized all-passing summary; `failed` with a blocking finding when tests failed; otherwise `errored`.
 */
export async function runTestCheck(request: TestCheckRequest): Promise<CheckOutcome> {
  const timeoutMs = request.timeoutMs ?? TEST_RUN_TIMEOUT_MS;
  const outputDir = path.join(request.verifyDir, 'output');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const first = request.fixtures.files[0];
  const base = { fixtureSha256: first?.sha256 ?? null, fixtureRowCount: first?.rowCount ?? null, fixtures: request.fixtures.files.map(({ uploadId, sha256 }) => ({ uploadId, sha256 })) };
  let result: PythonRunResult;
  try {
    result = await request.runner.run({ executionId: request.executionId, workingDir: request.versionDir, args: PYTEST_ARGS, env: { AUTOMATE_INPUT_DIR: request.fixtures.directory, AUTOMATE_OUTPUT_DIR: outputDir }, timeoutMs, signal: request.signal });
  } catch {
    return erroredOutcome('The test re-run could not start: uv or Python is not available, or the Python environment is not prepared.', null, base);
  } finally {
    // Scratch output is not an artifact and must never be mistaken for one.
    rmSync(outputDir, { recursive: true, force: true });
  }
  return settle(result, timeoutMs, base);
}

function settle(result: PythonRunResult, timeoutMs: number, base: Record<string, unknown>): CheckOutcome {
  const report = parsePytestReport(`${result.stdout}\n${result.stderr}`);
  const excerpt = capHeadTail(`${result.stdout}\n${result.stderr}`.trim(), TEST_OUTPUT_EXCERPT_BYTES);
  const detail = { ...base, total: report.total, passed: report.passed, failed: report.failed, exitCode: result.exitCode, durationMs: result.durationMs, outputExcerpt: excerpt.text, outputTruncated: excerpt.truncated || result.droppedBytes > 0 };
  const problem = unusable(result, report, timeoutMs);
  if (problem) return erroredOutcome(problem, result.durationMs, detail);
  const rows = typeof base.fixtureRowCount === 'number' ? ` against ${base.fixtureRowCount} synthetic rows` : '';
  if (result.outcome === 'passed' && report.failed === 0) return { status: 'passed', findings: [], summary: `${report.passed} of ${report.total} tests passed${rows}`, detail, durationMs: result.durationMs };
  const failedCount = report.failed ?? 0;
  const finding = resolveFinding('tests', { ruleCode: 'tests_failed', severity: 'high', confidence: null, filePath: null, line: null, column: null, message: `${failedCount} of ${report.total} tests failed when this app re-ran them.` });
  return { status: 'failed', findings: [finding], summary: `${plural(failedCount, 'failing test')}: ${report.passed} of ${report.total} passed${rows}`, detail, durationMs: result.durationMs };
}
