// Shared runner for the two static checkers (FEAT-107 TASK-006). Both tools
// exit non-zero when they FIND something, so a non-zero exit with parseable
// JSON is a normal result. Unparseable output, a timeout, or a spawn failure
// means the check could not run: `errored`, which blocks.
//
// Tool output describes model-written code: it is untrusted, stored only as
// normalized findings, and never logged.

import { formatDurationMs, type CheckKey } from '@automate/core';
import type { CheckerResult, CheckerTool } from '../verify-env';
import { capFindings, erroredOutcome, plural, resolveFinding, type CheckOutcome, type RawFinding } from './check-result';

/** Runs one checker; `VerifyEnvironment.runTool` in production. */
export type ToolRunner = (tool: CheckerTool, args: readonly string[], timeoutMs: number, signal: AbortSignal) => Promise<CheckerResult>;

export interface StaticCheckSpec {
  readonly checkKey: Extract<CheckKey, 'lint' | 'security'>;
  readonly tool: CheckerTool;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  /** Parse stdout into findings; return null when it is not the tool's JSON. */
  readonly parse: (stdout: string) => { readonly findings: readonly RawFinding[]; readonly detail?: Record<string, unknown> } | null;
  /** How a blocking finding is counted in the summary, e.g. `code error`. */
  readonly blockingNoun: string;
}

/** Why a tool run did not produce a usable result, or null when it did. */
function failure(tool: string, result: CheckerResult, timeoutMs: number): string | null {
  if (result.aborted) return `${tool} was stopped before it finished (aborted).`;
  if (result.timedOut) return `${tool} took longer than ${formatDurationMs(timeoutMs)} and was stopped, so this code was not checked.`;
  if (result.spawnError) return `${tool} could not be started, so this code was not checked.`;
  return null;
}

/**
 * Run one static checker and normalize its findings.
 * @param run The tool runner.
 * @param spec Tool, arguments, limit, and parser.
 * @returns `passed` with advisory findings, `failed` with at least one blocking finding, or `errored`.
 */
export async function runStaticCheck(run: ToolRunner, spec: StaticCheckSpec, signal: AbortSignal): Promise<CheckOutcome> {
  const result = await run(spec.tool, spec.args, spec.timeoutMs, signal);
  const problem = failure(spec.tool, result, spec.timeoutMs);
  if (problem) return erroredOutcome(problem, result.durationMs, { tool: spec.tool });
  const parsed = safeParse(spec, result.stdout);
  if (!parsed) return erroredOutcome(`${spec.tool} ran but its report could not be read (exit code ${result.exitCode ?? 'unknown'}), so this code was not checked.`, result.durationMs, { tool: spec.tool });
  const { kept, overflow } = capFindings(parsed.findings.map((finding) => resolveFinding(spec.checkKey, finding)));
  const blocking = kept.filter(({ isBlocking }) => isBlocking).length;
  const advisory = kept.length - blocking + overflow;
  return { status: blocking > 0 ? 'failed' : 'passed', findings: kept, summary: summarize(spec, blocking, advisory, overflow), durationMs: result.durationMs, detail: { tool: spec.tool, exitCode: result.exitCode, total: kept.length + overflow, overflow, ...parsed.detail } };
}

function safeParse(spec: StaticCheckSpec, stdout: string) {
  try { return spec.parse(stdout); } catch { return null; }
}

function summarize(spec: StaticCheckSpec, blocking: number, advisory: number, overflow: number): string {
  const parts: string[] = [];
  if (blocking > 0) parts.push(plural(blocking, spec.blockingNoun));
  if (advisory > 0) parts.push(plural(advisory, 'advisory finding'));
  const head = parts.length === 0 ? (spec.checkKey === 'lint' ? 'Lint clean' : 'No security findings') : parts.join(' and ');
  return overflow > 0 ? `${head}; ${overflow} more not shown (only the first ${spec.checkKey === 'lint' ? 'lint' : 'security'} findings are stored)` : head;
}
