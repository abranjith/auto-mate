// ---------------------------------------------------------------------------
// Synthetic test data (FEAT-106 TASK-002).
//
// INVARIANT: every literal in the output is either a cell of the approved
// disclosure payload (a verbatim sample row, or a low-cardinality column's
// disclosed frequent value) or a value this function invented from disclosed
// statistics. No byte of the source file reaches it by any other route —
// this function takes a profile, never a path, and adding a parameter that
// takes an upload's path or bytes would defeat the feature: the agent's tests
// would then run against the person's real data before anything was verified.
//
// Module invariant: pure and deterministic. The same source and seed always
// yield identical output — no clock, no `Math.random`, no I/O, no Node
// built-ins — so a retry tests against byte-identical data.
//
// A high-cardinality column discloses no values (D04), so its synthesized
// cells are drawn fresh and never repeat one of its sample cells.
// ---------------------------------------------------------------------------

import type { ColumnStats, InferredType, NumericStats, TemporalStats, TopValue } from '../contracts/upload-api';
import { SAMPLE_CELL_MAX_CHARS } from '../ingestion/limits';
import { seededRandom } from '../ingestion/seeded-random';

/** The column facts a fixture is built from. `ColumnProfile` and `DisclosedColumn` both satisfy it. */
export interface SyntheticColumn {
  readonly position: number;
  readonly name: string;
  readonly inferredType: InferredType;
  readonly nullCount: number;
  readonly blankCount: number;
  /** Populated cells; absent on a disclosed column, where the table's `rowCount` stands in. */
  readonly valueCount?: number;
  readonly isHighCardinality: boolean;
  readonly stats: ColumnStats | null;
  readonly topValues: readonly TopValue[] | null;
}

/** The table facts a fixture is built from. `TableProfile` and `DisclosedTable` both satisfy it. */
export interface SyntheticSource {
  readonly rowCount: number;
  readonly columns: readonly SyntheticColumn[];
  readonly sampleRows: readonly (readonly string[])[];
}

/** A built fixture table: header, then the verbatim sample rows, then synthesized rows. */
export interface SyntheticTable {
  readonly header: string[];
  readonly rows: string[][];
  /** How many leading rows are the approved sample rows, verbatim. */
  readonly sampleRowCount: number;
}

/** How many rows to build and from which seed. */
export interface SyntheticOptions {
  readonly rowCount: number;
  readonly seed: string;
}

type Random = () => number;
const SYLLABLES = ['ba', 'de', 'fi', 'go', 'hu', 'ka', 'le', 'mi', 'no', 'pu', 'ra', 'se', 'ti', 'vo', 'wa', 'ze'];
const MAX_RESAMPLES = 16;

const between = (random: Random, low: number, high: number) => low + random() * (high - low);
const intBetween = (random: Random, low: number, high: number) => Math.floor(between(random, low, high + 1));

/** Decimal places a numeric column is written with, read from its verbatim sample cells. */
function decimalScale(samples: readonly string[], stats: NumericStats): number {
  const places = [...samples, String(stats.min), String(stats.max)].map((text) => /^[+-]?\d*\.(\d+)$/.exec(text.trim())?.[1]?.length ?? 0);
  return Math.min(6, Math.max(...places, 0)) || 2;
}

function synthesizeNumber(random: Random, type: InferredType, stats: NumericStats, scale: number): string {
  if (type === 'integer') return String(intBetween(random, Math.ceil(stats.min), Math.max(Math.ceil(stats.min), Math.floor(stats.max))));
  const factor = 10 ** scale;
  const low = Math.ceil(stats.min * factor);
  const high = Math.max(low, Math.floor(stats.max * factor));
  return (intBetween(random, low, high) / factor).toFixed(scale);
}

/** Epoch milliseconds (UTC) for a profile's ISO bound such as `2026-01-03` or `2026-01-03T10:00:00Z`. */
function epochOf(iso: string): number {
  const normalized = iso.length === 10 ? `${iso}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const value = Date.parse(normalized);
  return Number.isNaN(value) ? 0 : value;
}

/** Render an instant in a profile's detected pattern, for example `DD/MM/YYYY HH:mm:ss`. */
function renderTemporal(epoch: number, type: InferredType, format: string): string {
  const date = new Date(epoch);
  const two = (value: number) => String(value).padStart(2, '0');
  const tokens: Record<string, string> = { YYYY: String(date.getUTCFullYear()).padStart(4, '0'), MM: two(date.getUTCMonth() + 1), DD: two(date.getUTCDate()), HH: two(date.getUTCHours()), mm: two(date.getUTCMinutes()), ss: two(date.getUTCSeconds()) };
  const pattern = format === 'excel-native' ? (type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss') : format;
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token] ?? token);
}

function synthesizeTemporal(random: Random, type: InferredType, stats: TemporalStats): string {
  const [low, high] = [epochOf(stats.min), epochOf(stats.max)].sort((a, b) => a - b) as [number, number];
  const step = type === 'date' ? 86_400_000 : 1_000;
  const first = Math.ceil(low / step);
  const epoch = intBetween(random, first, Math.max(first, Math.floor(high / step))) * step;
  return renderTemporal(Math.min(high, Math.max(low, epoch)), type, stats.detectedFormat);
}

/** Pronounceable filler, clearly invented, with a length inside the observed bounds. */
function synthesizeText(random: Random, minLength: number, maxLength: number): string {
  const low = Math.max(1, Math.min(minLength, SAMPLE_CELL_MAX_CHARS));
  const target = intBetween(random, low, Math.max(low, Math.min(maxLength, SAMPLE_CELL_MAX_CHARS)));
  let text = '';
  while (text.length < target) text += SYLLABLES[intBetween(random, 0, SYLLABLES.length - 1)];
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, target);
}

/** Draw from disclosed frequent values in proportion to their observed counts. */
function drawWeighted(random: Random, values: readonly TopValue[]): string {
  const total = values.reduce((sum, { count }) => sum + count, 0);
  let pick = random() * total;
  for (const { value, count } of values) {
    pick -= count;
    if (pick < 0) return value;
  }
  return values.at(-1)?.value ?? '';
}

/** One invented value for a column, from its type and statistics only. */
function synthesizeValue(random: Random, column: SyntheticColumn, scale: number, literals: readonly string[]): string {
  const { stats, inferredType: type } = column;
  if (type === 'empty') return '';
  if (type === 'boolean') return literals[intBetween(random, 0, literals.length - 1)] ?? 'true';
  if ((type === 'integer' || type === 'decimal') && stats?.kind === 'numeric') return synthesizeNumber(random, type, stats, scale);
  if ((type === 'date' || type === 'datetime') && stats?.kind === 'temporal') return synthesizeTemporal(random, type, stats);
  if (stats?.kind === 'string') return synthesizeText(random, stats.minLength, stats.maxLength);
  if (type === 'integer') return String(intBetween(random, 0, 100));
  return synthesizeText(random, 4, 12);
}

/** Build one column's value generator, honoring its empty-cell rate and cardinality rule. */
function columnGenerator(column: SyntheticColumn, samples: readonly string[], seed: string, total: number): () => string {
  const values = seededRandom(`${seed}:values:${column.position}`);
  const empties = seededRandom(`${seed}:empties:${column.position}`);
  const missing = column.nullCount + column.blankCount;
  const cells = column.valueCount === undefined ? Math.max(total, missing) : missing + column.valueCount;
  const emptyRate = cells === 0 ? 0 : missing / cells;
  const scale = column.stats?.kind === 'numeric' ? decimalScale(samples, column.stats) : 0;
  const disclosed = column.isHighCardinality ? null : column.topValues?.length ? column.topValues : null;
  const bounds = column.stats?.kind === 'numeric' ? [String(column.stats.min), String(column.stats.max)] : [];
  const forbidden = new Set(column.isHighCardinality ? [...samples, ...bounds] : []);
  const trimmed = samples.map((cell) => cell.trim());
  const literals = [trimmed.find((cell) => /^true$/i.test(cell)) ?? 'true', trimmed.find((cell) => /^false$/i.test(cell)) ?? 'false'];
  return () => {
    if (column.inferredType === 'empty' || empties() < emptyRate) return '';
    if (disclosed) return drawWeighted(values, disclosed);
    let value = synthesizeValue(values, column, scale, literals);
    for (let tries = 0; forbidden.has(value) && tries < MAX_RESAMPLES; tries += 1) value = synthesizeValue(values, column, scale, literals);
    return forbidden.has(value) ? '' : value;
  };
}

/**
 * Build a deterministic stand-in table from a profile.
 *
 * Order and inputs are fixed: the header from column names in position order;
 * then the approved sample rows verbatim; then synthesized rows drawn per
 * column from the disclosed type and statistics, sampling disclosed frequent
 * values by frequency for low-cardinality columns and honoring each column's
 * empty-cell rate.
 *
 * @param profile A table profile or disclosed table. Never a path.
 * @param options Total rows (samples included) and the seed.
 * @returns The header, rows, and how many leading rows are verbatim samples.
 * @example buildSyntheticFixture(table, { rowCount: 200, seed: 'a1b2c3' }).rows.length // 200
 */
export function buildSyntheticFixture(profile: SyntheticSource, options: SyntheticOptions): SyntheticTable {
  const columns = [...profile.columns].sort((left, right) => left.position - right.position);
  if (columns.length === 0) return { header: [], rows: [], sampleRowCount: 0 };
  const width = columns.length;
  const rowCount = Math.max(0, Math.floor(options.rowCount));
  const samples = profile.sampleRows.slice(0, rowCount).map((row) => Array.from({ length: Math.max(width, row.length) }, (_, index) => row[index] ?? ''));
  const generators = columns.map((column, index) => columnGenerator(column, samples.map((row) => row[index] ?? ''), options.seed, profile.rowCount));
  const synthesized = Array.from({ length: rowCount - samples.length }, () => generators.map((next) => next()));
  return { header: columns.map(({ name }) => name), rows: [...samples, ...synthesized], sampleRowCount: samples.length };
}
