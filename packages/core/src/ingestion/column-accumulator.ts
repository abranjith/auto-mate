// ---------------------------------------------------------------------------
// Bounded single-pass column statistics (FEAT-104 TASK-003).
//
// Module invariant: pure, no Node built-ins, no I/O.
//
// Memory is bounded independent of row count. Every structure here is either
// a fixed set of counters or capped:
//
// - Welford's algorithm gives mean and standard deviation from three numbers.
// - The value-count map is DISCARDED OUTRIGHT the moment it reaches
//   `CARDINALITY_TRACKING_CAP` distinct values, or sees a value longer than
//   `TRACKED_VALUE_MAX_CHARS`. The column is then high-cardinality for good:
//   it reports no distinct count and no frequent values. This is the D04
//   privacy rule and the memory rule as one mechanism — there is nothing left
//   to disclose because nothing was kept.
// - Median and quartiles come from a `NUMERIC_RESERVOIR_SIZE` reservoir
//   (Algorithm R) seeded from the file's SHA-256, so they are reproducible.
// ---------------------------------------------------------------------------

import type { ColumnStats, InferredType, TopValue } from '../contracts/upload-api';
import { CARDINALITY_TRACKING_CAP, NUMERIC_RESERVOIR_SIZE, TOP_VALUES_COUNT, TRACKED_VALUE_MAX_CHARS } from './limits';
import { seededRandom } from './seeded-random';
import { cellText, classifyCell, TypeTally, type CellValue, type ResolvedType } from './type-inference';

/** Everything a column profile holds except its position and name. */
export interface ColumnSummary {
  readonly inferredType: InferredType;
  readonly typeConfidence: number;
  readonly isMixedType: boolean;
  readonly nullCount: number;
  readonly blankCount: number;
  readonly valueCount: number;
  readonly distinctCount: number | null;
  readonly isHighCardinality: boolean;
  readonly stats: ColumnStats | null;
  readonly topValues: TopValue[] | null;
}

/** Tuning for tests; production uses the D04 constants. */
export interface AccumulatorOptions {
  readonly cardinalityCap?: number;
  readonly reservoirSize?: number;
}

/**
 * Accumulate one column's statistics in a single pass with bounded memory.
 *
 * @example
 * const column = new ColumnAccumulator(sha256 + ':0:3');
 * for (const row of rows) column.push(row[3] ?? null);
 * column.summarize();
 */
export class ColumnAccumulator {
  private nulls = 0;
  private blanks = 0;
  private values = 0;
  private readonly tally = new TypeTally();
  private counts: Map<string, number> | null = new Map();
  private numeric = { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity };
  private length = { min: Infinity, max: 0, total: 0 };
  private readonly reservoir: number[] = [];
  private random: (() => number) | null = null;
  private readonly cardinalityCap: number;
  private readonly reservoirSize: number;

  /** @param seed Reservoir seed, normally `<sha256>:<table>:<column>`. @param options Test-only overrides. */
  constructor(
    private readonly seed: string,
    options: AccumulatorOptions = {},
  ) {
    this.cardinalityCap = options.cardinalityCap ?? CARDINALITY_TRACKING_CAP;
    this.reservoirSize = options.reservoirSize ?? NUMERIC_RESERVOIR_SIZE;
  }

  /** True once value tracking has been discarded for this column. */
  get isHighCardinality(): boolean {
    return this.counts === null;
  }

  /** How many values this accumulator currently retains (tracked distinct values plus reservoir). For memory tests. */
  retainedValueCount(): number {
    return (this.counts?.size ?? 0) + this.reservoir.length;
  }

  /** Record `count` missing cells at once, used when a table widens after rows were seen. */
  pushNulls(count: number): void {
    this.nulls += count;
  }

  /**
   * Record one cell in O(1) amortised time.
   *
   * @param value The cell; null means missing, whitespace means blank.
   */
  push(value: CellValue): void {
    const kind = classifyCell(value);
    if (kind === 'null') {
      this.nulls += 1;
      return;
    }
    if (kind === 'blank') {
      this.blanks += 1;
      return;
    }
    this.values += 1;
    this.tally.push(value, kind);
    const text = typeof value === 'string' ? value : cellText(value);
    this.recordLength(text.length);
    if (kind === 'integer' || kind === 'decimal') this.recordNumber(typeof value === 'number' ? value : Number(text.trim()));
    this.track(text);
  }

  private recordLength(length: number): void {
    this.length.min = Math.min(this.length.min, length);
    this.length.max = Math.max(this.length.max, length);
    this.length.total += length;
  }

  private recordNumber(value: number): void {
    const stat = this.numeric;
    stat.count += 1;
    const delta = value - stat.mean;
    stat.mean += delta / stat.count;
    stat.m2 += delta * (value - stat.mean);
    stat.min = Math.min(stat.min, value);
    stat.max = Math.max(stat.max, value);
    if (this.reservoir.length < this.reservoirSize) {
      this.reservoir.push(value);
      return;
    }
    this.random ??= seededRandom(this.seed);
    const slot = Math.floor(this.random() * stat.count);
    if (slot < this.reservoirSize) this.reservoir[slot] = value;
  }

  private track(text: string): void {
    if (this.counts === null) return;
    if (text.length > TRACKED_VALUE_MAX_CHARS) {
      this.counts = null;
      return;
    }
    this.counts.set(text, (this.counts.get(text) ?? 0) + 1);
    if (this.counts.size >= this.cardinalityCap) this.counts = null;
  }

  /** Produce the column's summary. Deterministic: the same pushes and seed give identical output. */
  summarize(): ColumnSummary {
    const resolved = this.tally.resolve();
    const counts = this.counts;
    return {
      inferredType: resolved.inferredType,
      typeConfidence: resolved.typeConfidence,
      isMixedType: resolved.isMixedType,
      nullCount: this.nulls,
      blankCount: this.blanks,
      valueCount: this.values,
      distinctCount: counts === null ? null : counts.size,
      isHighCardinality: counts === null,
      stats: this.stats(resolved),
      topValues: counts === null ? null : topValues(counts),
    };
  }

  private stats(resolved: ResolvedType): ColumnStats | null {
    const type = resolved.inferredType;
    if ((type === 'integer' || type === 'decimal') && this.numeric.count > 0) return this.numericStats();
    if ((type === 'date' || type === 'datetime') && resolved.temporal) return { kind: 'temporal', ...resolved.temporal };
    if (type === 'string' && this.values > 0) {
      return { kind: 'string', minLength: this.length.min, maxLength: this.length.max, meanLength: this.length.total / this.values };
    }
    return null;
  }

  private numericStats(): ColumnStats {
    const { count, mean, m2, min, max } = this.numeric;
    const sorted = Float64Array.from(this.reservoir).sort();
    return {
      kind: 'numeric',
      min,
      max,
      mean,
      stddev: count < 2 ? null : Math.sqrt(m2 / (count - 1)),
      median: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      approximate: count > this.reservoirSize,
    };
  }
}

/**
 * Linear-interpolated percentile of sorted values (the numpy/pandas default).
 *
 * @param sorted Ascending values; must be non-empty.
 * @param fraction 0..1.
 * @returns The interpolated value.
 */
export function percentile(sorted: Float64Array, fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lower = sorted[low]!;
  return lower + (sorted[high]! - lower) * (position - low);
}

function topValues(counts: ReadonlyMap<string, number>): TopValue[] {
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, TOP_VALUES_COUNT)
    .map(([value, count]) => ({ value, count }));
}
