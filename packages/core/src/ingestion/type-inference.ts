// ---------------------------------------------------------------------------
// Cell classification and column type resolution (FEAT-104 TASK-002/003).
//
// Module invariant: pure and synchronous, no Node built-ins, no I/O.
//
// Two levels live here and they are deliberately separate:
//
// - `classifyCell` looks at ONE value and says what it could be. For a text
//   date it reports every pattern that explains it, not a guess.
// - `TypeTally` looks at a whole COLUMN of classifications and decides. A type
//   is inferred only when at least 99% of populated values fit it. When day/
//   month and month/day explain exactly the same values — which happens
//   whenever every day-of-month is 12 or less — the column is still a date, but
//   it is marked ambiguous and both formats are recorded. Guessing there would
//   silently reinterpret a person's data; the ambiguity is the finding.
// ---------------------------------------------------------------------------

import type { InferredType } from '../contracts/upload-api';

/** A cell as a reader delivers it: text from CSV, typed values from XLSX. */
export type CellValue = string | number | boolean | Date | null;

/** What a reader declared a cell to be, before any inference. */
export type CellSourceType = 'string' | 'number' | 'boolean' | 'date' | 'null';

/** What one cell could be. `temporal` means at least one date pattern explains it. */
export type CellKind = 'null' | 'blank' | 'integer' | 'decimal' | 'boolean' | 'temporal' | 'string';

/** The share of populated values a type must explain before a column is given that type. */
export const TYPE_THRESHOLD = 0.99;

/** Date layouts recognised in text. Each also has a `T`-separated and a space-separated datetime variant. */
const DATE_LAYOUTS = ['YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'MM-DD-YYYY'] as const;
const TIME_VARIANTS = ['', 'T', ' '] as const;

/** Every text temporal pattern, as a label a person and generated code can both read. */
export const TEMPORAL_PATTERNS: readonly string[] = TIME_VARIANTS.flatMap((separator) =>
  DATE_LAYOUTS.map((layout) => (separator === '' ? layout : `${layout}${separator}HH:mm:ss`)),
);

/** The label used for dates a workbook stored as real date cells rather than text. */
export const NATIVE_TEMPORAL_FORMAT = 'excel-native';

/** Pattern pairs that read the same digits as day/month versus month/day. */
const AMBIGUOUS_PAIRS: readonly (readonly [number, number])[] = TIME_VARIANTS.flatMap((_, variant) => [
  [variant * 6 + 2, variant * 6 + 3] as const,
  [variant * 6 + 4, variant * 6 + 5] as const,
]);

const INTEGER = /^[+-]?(?:0|[1-9]\d{0,14})$/;
const DECIMAL = /^[+-]?(?:(?:0|[1-9]\d*)\.\d+|\.\d+|(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?\d+)$/;
const BOOLEAN = /^(?:true|false)$/i;
const DATE_ISO = /^(\d{4})([-/])(\d{2}|\d{1,2})\2(\d{2}|\d{1,2})(.*)$/;
const DATE_DMY = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})(.*)$/;
const TIME = /^([T ])(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:\s?([AaPp][Mm]))?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Report what a reader declared a cell to be.
 *
 * @param value A cell value.
 * @returns Its declared type; text from a CSV is always `string`.
 * @example cellSourceType(new Date()) // 'date'
 */
export function cellSourceType(value: CellValue): CellSourceType {
  if (value === null) return 'null';
  if (value instanceof Date) return 'date';
  return typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
}

function daysInMonth(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Parse the optional time suffix. Returns `null` when invalid, `''` when absent. */
function parseTime(rest: string): { variant: number; iso: string } | null {
  if (rest === '') return { variant: 0, iso: '' };
  const match = TIME.exec(rest);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  const meridiem = match[5]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { variant: match[1] === 'T' ? 1 : 2, iso: `T${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** One text value's temporal readings: a bitmask of explaining patterns and each reading's ISO form. */
export interface TemporalReadings {
  readonly mask: number;
  readonly iso: ReadonlyMap<number, string>;
}

/**
 * Report every temporal pattern that explains a text value.
 *
 * @param text A trimmed, non-empty cell.
 * @returns The explaining patterns (indexes into `TEMPORAL_PATTERNS`) and the ISO reading under each, or `null` when none does.
 * @example matchTemporal('03/04/2026')?.mask // DD/MM/YYYY and MM/DD/YYYY both set
 */
export function matchTemporal(text: string): TemporalReadings | null {
  if (text.length < 8 || text.length > 40) return null;
  const readings = new Map<number, string>();
  const iso = DATE_ISO.exec(text);
  if (iso) {
    const time = parseTime(iso[5] ?? '');
    const date = isoDate(Number(iso[1]), Number(iso[3]), Number(iso[4]));
    const exactDigits = iso[3]!.length === 2 && iso[4]!.length === 2;
    if (time && date && (iso[2] === '/' || exactDigits)) readings.set(time.variant * 6 + (iso[2] === '-' ? 0 : 1), date + time.iso);
  }
  const dmy = DATE_DMY.exec(text);
  if (dmy) {
    const time = parseTime(dmy[5] ?? '');
    const [first, second, year] = [Number(dmy[1]), Number(dmy[3]), Number(dmy[4])];
    const base = time ? time.variant * 6 + (dmy[2] === '/' ? 2 : 4) : -1;
    const asDayMonth = time && isoDate(year, second, first);
    const asMonthDay = time && isoDate(year, first, second);
    if (time && asDayMonth) readings.set(base, asDayMonth + time.iso);
    if (time && asMonthDay) readings.set(base + 1, asMonthDay + time.iso);
  }
  if (readings.size === 0) return null;
  let mask = 0;
  for (const index of readings.keys()) mask |= 1 << index;
  return { mask, iso: readings };
}

/**
 * Numbers larger than this are treated as text. Statistics over them could
 * overflow to `Infinity`, which does not survive a JSON round trip, and no
 * real table measures anything at that scale.
 */
export const NUMERIC_MAGNITUDE_LIMIT = 1e100;

function isStatisticalNumber(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= NUMERIC_MAGNITUDE_LIMIT;
}

/**
 * Parse a text cell as a finite number, or return `null`.
 *
 * Integers need no leading zeros and at most 15 digits: `"0012"` is a code,
 * not a number, and a 20-digit account number is not arithmetic data either.
 *
 * @param text A trimmed cell.
 * @returns `{ value, integer }` or `null`.
 * @example parseNumber('-3.5') // { value: -3.5, integer: false }
 */
export function parseNumber(text: string): { value: number; integer: boolean } | null {
  if (INTEGER.test(text)) return { value: Number(text), integer: true };
  if (!DECIMAL.test(text)) return null;
  const value = Number(text);
  return isStatisticalNumber(value) ? { value, integer: false } : null;
}

/**
 * Classify one cell. Text is trimmed for classification only.
 *
 * @param value A cell as a reader delivered it.
 * @returns What the cell could be.
 * @example classifyCell('0012') // 'string'
 */
export function classifyCell(value: CellValue): CellKind {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    if (!isStatisticalNumber(value)) return 'string';
    return Number.isSafeInteger(value) ? 'integer' : 'decimal';
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'null' : 'temporal';
  const text = value.trim();
  if (text === '') return 'blank';
  if (BOOLEAN.test(text)) return 'boolean';
  const number = parseNumber(text);
  if (number) return number.integer ? 'integer' : 'decimal';
  return matchTemporal(text) ? 'temporal' : 'string';
}

/**
 * Render a cell as the text a sample row shows.
 *
 * @param value A cell.
 * @returns Text: dates as ISO-8601 (date only at UTC midnight), booleans lower-case, null as empty.
 * @example cellText(new Date(Date.UTC(2026, 8, 14))) // '2026-09-14'
 */
export function cellText(value: CellValue): string {
  if (value === null) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  return String(value);
}

/** The decision a `TypeTally` reaches for one column. */
export interface ResolvedType {
  readonly inferredType: InferredType;
  readonly typeConfidence: number;
  readonly isMixedType: boolean;
  /** For temporal columns: the winning pattern's label and bounds, and the tied alternative if ambiguous. */
  readonly temporal: {
    readonly detectedFormat: string;
    readonly min: string;
    readonly max: string;
    readonly ambiguous: boolean;
    readonly alternateFormat: string | null;
  } | null;
}

interface PatternStat {
  count: number;
  min: string | null;
  max: string | null;
}

/**
 * Counts cell kinds for one column in O(1) memory and resolves its type.
 *
 * Memory is fixed: a handful of counters plus one slot per temporal pattern,
 * regardless of how many values are pushed.
 */
export class TypeTally {
  private populated = 0;
  private integers = 0;
  private decimals = 0;
  private booleans = 0;
  private strings = 0;
  private readonly patterns: PatternStat[] = TEMPORAL_PATTERNS.map(() => ({ count: 0, min: null, max: null }));
  private readonly pairBoth: number[] = AMBIGUOUS_PAIRS.map(() => 0);
  private readonly native: PatternStat & { hasTime: boolean } = { count: 0, min: null, max: null, hasTime: false };

  /**
   * Record one cell.
   *
   * @param value The cell.
   * @param kind Its classification, when the caller already computed it.
   * @returns The kind recorded.
   */
  push(value: CellValue, kind: CellKind = classifyCell(value)): CellKind {
    if (kind === 'null' || kind === 'blank') return kind;
    this.populated += 1;
    if (kind === 'integer') this.integers += 1;
    else if (kind === 'decimal') this.decimals += 1;
    else if (kind === 'boolean') this.booleans += 1;
    else if (kind === 'string') this.strings += 1;
    else if (value instanceof Date) this.pushNative(value);
    else this.pushTemporalText(String(value).trim());
    return kind;
  }

  private pushNative(value: Date): void {
    const text = cellText(value);
    this.native.count += 1;
    this.native.hasTime ||= text.length > 10;
    widen(this.native, text);
  }

  private pushTemporalText(text: string): void {
    const readings = matchTemporal(text);
    if (!readings) {
      this.strings += 1;
      return;
    }
    for (const [index, iso] of readings.iso) widen(this.patterns[index]!, iso);
    AMBIGUOUS_PAIRS.forEach(([a, b], pair) => {
      if (readings.iso.has(a) && readings.iso.has(b)) this.pairBoth[pair]! += 1;
    });
  }

  /** Decide the column's type from everything pushed. @returns The inferred type, its confidence, and temporal details. */
  resolve(): ResolvedType {
    const total = this.populated;
    if (total === 0) return { inferredType: 'empty', typeConfidence: 1, isMixedType: false, temporal: null };
    const share = (count: number) => count / total;
    const scalar = (inferredType: InferredType, count: number): ResolvedType => ({
      inferredType,
      typeConfidence: share(count),
      isMixedType: count < total,
      temporal: null,
    });
    if (share(this.booleans) >= TYPE_THRESHOLD) return scalar('boolean', this.booleans);
    if (share(this.integers) >= TYPE_THRESHOLD) return scalar('integer', this.integers);
    if (share(this.integers + this.decimals) >= TYPE_THRESHOLD) return scalar('decimal', this.integers + this.decimals);
    return this.resolveTemporal(total) ?? scalar('string', this.strings);
  }

  private resolveTemporal(total: number): ResolvedType | null {
    if (this.native.count / total >= TYPE_THRESHOLD) {
      return {
        inferredType: this.native.hasTime ? 'datetime' : 'date',
        typeConfidence: this.native.count / total,
        isMixedType: this.native.count < total,
        temporal: bounds(this.native, NATIVE_TEMPORAL_FORMAT, false, null),
      };
    }
    let best = -1;
    this.patterns.forEach((stat, index) => {
      if (best < 0 || stat.count > this.patterns[best]!.count) best = index;
    });
    const winner = this.patterns[best]!;
    if (winner.count / total < TYPE_THRESHOLD) return null;
    const alternate = this.tiedAlternate(best);
    return {
      inferredType: best < 6 ? 'date' : 'datetime',
      typeConfidence: winner.count / total,
      isMixedType: winner.count < total,
      temporal: bounds(winner, TEMPORAL_PATTERNS[best]!, alternate !== null, alternate === null ? null : TEMPORAL_PATTERNS[alternate]!),
    };
  }

  /** Return the other pattern of an ambiguous pair when both explain exactly the same values. */
  private tiedAlternate(index: number): number | null {
    const pair = AMBIGUOUS_PAIRS.findIndex(([a, b]) => a === index || b === index);
    if (pair < 0) return null;
    const [a, b] = AMBIGUOUS_PAIRS[pair]!;
    const both = this.pairBoth[pair]!;
    const same = this.patterns[a]!.count === both && this.patterns[b]!.count === both;
    return same ? (index === a ? b : a) : null;
  }
}

function widen(stat: PatternStat, iso: string): void {
  stat.count += 1;
  if (stat.min === null || iso < stat.min) stat.min = iso;
  if (stat.max === null || iso > stat.max) stat.max = iso;
}

function bounds(stat: PatternStat, detectedFormat: string, ambiguous: boolean, alternateFormat: string | null): ResolvedType['temporal'] {
  return { detectedFormat, min: stat.min ?? '', max: stat.max ?? '', ambiguous, alternateFormat };
}
