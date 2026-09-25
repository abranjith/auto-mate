import { describe, expect, it } from 'vitest';
import { ColumnAccumulator, percentile } from '../../ingestion/column-accumulator';
import { CARDINALITY_TRACKING_CAP, TRACKED_VALUE_MAX_CHARS } from '../../ingestion/limits';
import { hash128, seededRandom } from '../../ingestion/seeded-random';
import type { CellValue } from '../../ingestion/type-inference';

function summarize(values: readonly CellValue[], seed = 'seed', options = {}) {
  const column = new ColumnAccumulator(seed, options);
  values.forEach((value) => column.push(value));
  return column.summarize();
}

/**
 * Heap tools for the memory-bound tests.
 *
 * Core is typechecked without Node types, so the one test that needs V8 loads
 * it dynamically instead of widening the package's type surface.
 */
async function heapTools(): Promise<{ gc(): void; heapUsed(): number }> {
  const load = (name: string) => import(/* @vite-ignore */ name) as Promise<unknown>;
  const v8 = (await load('node:v8')) as { setFlagsFromString(flags: string): void };
  const vm = (await load('node:vm')) as { runInNewContext(code: string): unknown };
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const host = (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process;
  return { gc, heapUsed: () => host.memoryUsage().heapUsed };
}

describe('ColumnAccumulator statistics', () => {
  it('matches a known-value fixture for mean and sample standard deviation', () => {
    const stats = summarize(['2', '4', '4', '4', '5', '5', '7', '9']).stats;
    expect(stats).toMatchObject({ kind: 'numeric', min: 2, max: 9, mean: 5 });
    expect(stats?.kind === 'numeric' && stats.stddev).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it('matches a naive two-pass computation over 10,000 values (numerical stability)', () => {
    const random = seededRandom('stability');
    const values = Array.from({ length: 10_000 }, () => 1e9 + random());
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
    const stats = summarize(values.map(String)).stats;
    if (stats?.kind !== 'numeric') throw new Error('expected numeric stats');
    expect(Math.abs(stats.mean - mean) / mean).toBeLessThan(1e-12);
    expect(Math.abs(stats.stddev! - Math.sqrt(variance)) / Math.sqrt(variance)).toBeLessThan(1e-6);
  });

  it('gets min and max right with negatives and zero', () => {
    expect(summarize(['-5', '0', '3', '-12.5']).stats).toMatchObject({ min: -12.5, max: 3 });
  });

  it('reports a null standard deviation for a single value', () => {
    expect(summarize(['7']).stats).toMatchObject({ stddev: null, median: 7, p25: 7, p75: 7 });
  });

  it('computes exact percentiles while the reservoir holds every value', () => {
    const stats = summarize(Array.from({ length: 101 }, (_, index) => index + 1));
    expect(stats.stats).toMatchObject({ median: 51, p25: 26, p75: 76, approximate: false });
  });

  it('flags percentiles approximate once values exceed the reservoir, and stays close', () => {
    const values = Array.from({ length: 5_000 }, (_, index) => index + 1);
    const stats = summarize(values, 'seed', { reservoirSize: 500 }).stats;
    if (stats?.kind !== 'numeric') throw new Error('expected numeric stats');
    expect(stats.approximate).toBe(true);
    expect(Math.abs(stats.median - 2500.5)).toBeLessThan(250);
  });

  it('is byte-identical for the same input and seed, and close for a different seed', () => {
    const values = Array.from({ length: 5_000 }, (_, index) => String((index * 7919) % 5_000));
    const first = JSON.stringify(summarize(values, 'a'.repeat(64), { reservoirSize: 300 }));
    const second = JSON.stringify(summarize(values, 'a'.repeat(64), { reservoirSize: 300 }));
    expect(second).toBe(first);
    const other = summarize(values, 'b'.repeat(64), { reservoirSize: 300 }).stats;
    if (other?.kind !== 'numeric') throw new Error('expected numeric stats');
    expect(Math.abs(other.median - 2499.5)).toBeLessThan(400);
  });

  it('counts null, blank, and populated cells separately', () => {
    expect(summarize([null, '', '  ', 'x', null])).toMatchObject({ nullCount: 2, blankCount: 2, valueCount: 1 });
  });

  it('reports string length statistics for text columns', () => {
    expect(summarize(['a', 'abc', 'abcde']).stats).toEqual({ kind: 'string', minLength: 1, maxLength: 5, meanLength: 3 });
  });

  it('reports temporal statistics for date columns and none for booleans or empties', () => {
    expect(summarize(['2026-01-02', '2025-12-31']).stats).toMatchObject({ kind: 'temporal', min: '2025-12-31', max: '2026-01-02' });
    expect(summarize(['true', 'false']).stats).toBeNull();
    expect(summarize([null, '']).stats).toBeNull();
  });
});

describe('ColumnAccumulator cardinality', () => {
  const distinct = (count: number) => Array.from({ length: count }, (_, index) => `value-${index}`);

  it('reports an exact distinct count and top five for 999 distinct values', () => {
    const summary = summarize([...distinct(999), 'value-3', 'value-3', 'value-7']);
    expect(summary).toMatchObject({ distinctCount: 999, isHighCardinality: false });
    expect(summary.topValues).toEqual([
      { value: 'value-3', count: 3 },
      { value: 'value-7', count: 2 },
      { value: 'value-0', count: 1 },
      { value: 'value-1', count: 1 },
      { value: 'value-10', count: 1 },
    ]);
  });

  it('discloses nothing for 1,001 distinct values', () => {
    expect(summarize(distinct(1_001))).toMatchObject({ distinctCount: null, topValues: null, isHighCardinality: true });
  });

  it('treats reaching the cap itself as high-cardinality ("fewer than 1,000")', () => {
    expect(summarize(distinct(CARDINALITY_TRACKING_CAP)).isHighCardinality).toBe(true);
  });

  it('treats a column holding one over-long value as free text and discloses nothing', () => {
    const summary = summarize(['a', 'b', 'x'.repeat(TRACKED_VALUE_MAX_CHARS + 1)]);
    expect(summary).toMatchObject({ distinctCount: null, topValues: null, isHighCardinality: true });
  });

  it('does not grow its retained size when 100,000 further distinct values arrive', () => {
    const column = new ColumnAccumulator('seed');
    distinct(1_001).forEach((value) => column.push(value));
    const before = column.retainedValueCount();
    for (let index = 0; index < 100_000; index += 1) column.push(`more-${index}`);
    expect(column.isHighCardinality).toBe(true);
    expect(column.retainedValueCount()).toBe(before);
    expect(before).toBe(0);
  });

  it('keeps retained heap flat across 1,000,000 values (the memory bound is real)', async () => {
    const { gc, heapUsed } = await heapTools();
    const column = new ColumnAccumulator('seed');
    for (let index = 0; index < 20_000; index += 1) column.push(index % 2 ? `warm-${index}` : String(index));
    gc();
    const baseline = heapUsed();
    for (let index = 0; index < 1_000_000; index += 1) column.push(index % 2 ? `row-${index}` : String(index));
    gc();
    const growth = heapUsed() - baseline;
    expect(column.retainedValueCount()).toBeLessThanOrEqual(10_000);
    expect(growth).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('helpers', () => {
  it('interpolates percentiles linearly', () => {
    expect(percentile(Float64Array.from([1, 2, 3, 4]), 0.5)).toBe(2.5);
    expect(percentile(Float64Array.from([5]), 0.25)).toBe(5);
  });

  it('seeds deterministically and differently per seed', () => {
    expect(hash128('x')).toEqual(hash128('x'));
    expect(hash128('x')).not.toEqual(hash128('y'));
    const [a, b] = [seededRandom('s'), seededRandom('s')];
    const values = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});
