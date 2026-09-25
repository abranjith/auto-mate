// pytest summary parsing (FEAT-106 TASK-008). Only counts leave this module,
// never text, so it may read raw output. It is deliberately tolerant: a parser
// that threw on unfamiliar output would turn a repairable failure into a
// crashed run, so anything unrecognized yields null counts instead.

/** Counts from pytest's final summary line; null when no summary was recognized. */
export interface PytestReport {
  readonly total: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  /** True when pytest could not collect the tests, for example an import error. */
  readonly collectionError: boolean;
}

const SUMMARY = /(?:^|[=\s])((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s/;
const COLLECTION = /error during collection|ERROR collecting|Interrupted: \d+ errors? during collection/;

/**
 * Read the counts from pytest `-q` output.
 *
 * @param output Raw stdout and stderr, concatenated. Never returned or logged.
 * @returns Counts where failures include errors, or null counts when no summary line was recognized.
 * @example parsePytestReport('1 failed, 2 passed in 0.12s') // { total: 3, passed: 2, failed: 1, collectionError: false }
 */
export function parsePytestReport(output: string): PytestReport {
  const collectionError = COLLECTION.test(output);
  const lines = output.split(/\r?\n/).reverse();
  if (lines.some((line) => /\bno tests ran in [\d.]+s/.test(line))) return { total: 0, passed: 0, failed: 0, collectionError };
  const summary = lines.map((line) => SUMMARY.exec(line)?.[1]).find((match) => match !== undefined);
  if (!summary) return { total: null, passed: null, failed: null, collectionError };
  const count = (pattern: RegExp) => Number(pattern.exec(summary)?.[1] ?? 0);
  const passed = count(/(\d+) passed/) + count(/(\d+) xpassed/);
  const failed = count(/(\d+) failed/) + count(/(\d+) errors?\b/);
  const other = count(/(\d+) skipped/) + count(/(\d+) xfailed/);
  return { total: passed + failed + other, passed, failed, collectionError };
}
