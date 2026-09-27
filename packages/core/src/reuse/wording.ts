import type { InferredType } from '../contracts/upload-api';
import type { CompatibilityFinding, CompatibilityFindingCode, CompatibilityReport } from './compatibility';

export const SAVED_TASK_KEEPS = 'A saved task keeps column and sheet names, your filenames as labels, your answers, and code that may mention a value the AI saw. It keeps no data rows and survives deleting the task it came from.';
export const REUSE_NOTHING_SENT = 'This file fits. Nothing is sent to the AI — the saved code is checked again, then waits for your go-ahead.';
export const REUSE_INTENT_CAVEAT = 'This is the saved code, unchanged. It was checked again on synthetic rows shaped like your new file.';
export const REPAIR_INSTRUCTIONS_PREFACE = 'Adapt the saved task for the new file using these choices:';
/** A saved-code run whose checks blocked on the new file (FEAT-107's gate, reworded for reuse). */
export const SAVED_CODE_CHECKS_FAILED = 'The saved task’s checks failed on your new file.';
/** Added when the saved code's own tests were among the blocking checks. */
export const SAVED_CODE_TESTS_FAILED = 'Its own tests failed on data shaped like your new file. This usually means the file differs in a way the saved task can’t handle.';
export const REPLAY_LIMITS ='Run again exactly reuses the code, input files, and as-of date. It runs on today’s locked runtime, so a changed Python or package version can change the result.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A `YYYY-MM-DD` calendar date as "25 Sep 2026", independent of the viewer's locale.
 * @param date A calendar date string.
 * @returns The date in day-month-year words, or the input unchanged when it is not a date.
 * @example formatCalendarDate('2026-09-25') // '25 Sep 2026'
 */
export function formatCalendarDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month} ${match[1]}` : date;
}

/** The run header's as-of line: "As of 25 Sep 2026 · Europe/London", plus where the date came from.
 * @param asOf The run's recorded date, zone, and source.
 * @returns One line for the run page.
 * @example describeAsOf({ date: '2026-09-25', timeZone: 'Europe/London', source: 'chosen' })
 */
export function describeAsOf(asOf: { readonly date: string; readonly timeZone: string; readonly source: string }): string {
  const origin = asOf.source === 'chosen' ? ' · the date you chose' : asOf.source === 'copied' ? ' · the same date as the run it repeats' : '';
  return `As of ${formatCalendarDate(asOf.date)} · ${asOf.timeZone}${origin}`;
}

const TYPE_WORDS: Readonly<Record<InferredType, string>> = { integer: 'whole numbers', decimal: 'numbers', boolean: 'yes/no values', date: 'dates', datetime: 'dates and times', string: 'text', empty: 'empty' };

/** A profiled column type in plain words ("numbers", "dates"), for the person's screen.
 * @param type A profiler type, or any other string, which is returned unchanged.
 * @returns Plain words for the type.
 * @example describeColumnType('decimal') // 'numbers'
 */
export function describeColumnType(type: string): string {
  return (TYPE_WORDS as Readonly<Record<string, string>>)[type] ?? type;
}

const HEADLINES: Readonly<Record<CompatibilityFindingCode, string>> = {
  input_count_mismatch: 'The number of files is different', file_not_analyzed: 'This file is still being analyzed', format_mismatch: 'The file format changed', sheet_missing: 'A worksheet is missing', column_missing: 'A required column is missing', type_incompatible: 'A column has an incompatible type', rule_conflict: 'A saved decision conflicts with this file', decision_unrecorded: 'This file needs a new decision',
  type_changed: 'A column type changed', column_empty: 'A column is empty', no_data_rows: 'This table has no data rows', first_sheet_renamed: 'The first worksheet has a new name', undeclared_input: 'The saved code did not declare columns for this file', runtime_changed: 'The Python environment changed', runtime_unknown: 'The Python environment is not ready', wall_clock_with_chosen_date: 'The code may use the computer clock',
  rule_applied: 'A saved decision was applied', rule_not_needed: 'A saved decision is no longer needed', extra_columns: 'There are extra columns', optional_column_missing: 'An optional column is missing', reads_wall_clock: 'The code reads the computer clock',
};

/** Human wording is defined once for API reports and browser screens.
 * @param finding A structured compatibility finding.
 * @returns Its plain-language headline and detail.
 * @example describeCompatibilityFinding(report.findings[0])
 */
export function describeCompatibilityFinding(finding: CompatibilityFinding): { headline: string; detail: string } {
  const headline = HEADLINES[finding.code];
  const location = finding.column ? `Column “${finding.column}”` : finding.sheet ? `Worksheet “${finding.sheet}”` : finding.inputPosition >= 0 ? `File ${finding.inputPosition + 1}` : 'This run';
  const difference = finding.expected && finding.found ? ` Expected ${finding.expected}; found ${finding.found}.` : finding.expected ? ` Expected ${finding.expected}.` : '';
  return { headline, detail: `${location}: ${headline.toLocaleLowerCase()}.${difference}` };
}

/** Name the overall result without implying semantic correctness.
 * @param status The structural compatibility status.
 * @returns A sentence suitable for the person reviewing the report.
 * @example describeCompatibilityStatus('compatible')
 */
export function describeCompatibilityStatus(status: CompatibilityReport['status']): string {
  switch (status) {
    case 'compatible': return 'This file fits the saved task’s recorded shape.';
    case 'compatible_with_warnings': return 'This file fits, with warnings to review.';
    case 'incompatible': return 'This file needs choices or repair before it can run.';
    default: return status satisfies never;
  }
}
