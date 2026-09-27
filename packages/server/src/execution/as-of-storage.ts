import { asOfEnvironment, resolveAsOf, type AsOf } from '@automate/core';
import type { ExecutionRow } from '../db/repositories/execution-repository';

/** The server zone is only a fallback for clients that did not send theirs. */
export function defaultTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }

/** Store a validated as-of value in the four additive execution columns. */
export function asOfColumns(asOf: AsOf) {
  return { asOfAt: new Date(asOf.at * 1000), asOfDate: asOf.date, asOfTimezone: asOf.timeZone, asOfSource: asOf.source };
}

/** A new run resolves now; a chosen date is only accepted by the shared resolver. */
export function newAsOf(now: Date, timeZone?: string | null, chosenDate?: string | null): AsOf {
  return resolveAsOf({ nowMs: now.getTime(), timeZone: timeZone ?? defaultTimeZone(), chosenDate });
}

/** Retries and replays retain the source date; legacy rows resolve now. */
export function copiedAsOf(source: ExecutionRow, now: Date): AsOf {
  if (!source.asOfAt || !source.asOfDate || !source.asOfTimezone) return newAsOf(now);
  return { at: Math.floor(source.asOfAt.getTime() / 1000), date: source.asOfDate, timeZone: source.asOfTimezone, source: 'copied' };
}

/** Legacy executions deliberately send no as-of environment entries. */
export function executionAsOfEnvironment(row: Pick<ExecutionRow, 'asOfAt' | 'asOfDate' | 'asOfTimezone' | 'asOfSource'>): Record<string, string> {
  if (!row.asOfAt || !row.asOfDate || !row.asOfTimezone || !row.asOfSource) return {};
  return asOfEnvironment({ at: Math.floor(row.asOfAt.getTime() / 1000), date: row.asOfDate, timeZone: row.asOfTimezone, source: row.asOfSource as AsOf['source'] });
}
