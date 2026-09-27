import { EXECUTION_STATUSES, type ExecutionStatus } from '@automate/core';

/**
 * Render a list of execution statuses as SQL literals: `'a','b'`.
 *
 * SQLite matches a partial index only when the query's WHERE clause provably
 * implies the index predicate, and a bound `IN (?, ?)` list never does. The
 * `execution_active` and `execution_parked` predicates, and every query meant
 * to use them, therefore spell the list out from the same core constant. Only
 * members of `EXECUTION_STATUSES` are accepted, so nothing else reaches the SQL.
 *
 * @param statuses Statuses from a core constant.
 * @returns A comma-separated list of quoted literals.
 * @throws Error when a value is not an execution status.
 */
export function statusLiterals(statuses: readonly ExecutionStatus[]): string {
  for (const status of statuses) if (!(EXECUTION_STATUSES as readonly string[]).includes(status)) throw new Error(`Not an execution status: ${status}`);
  return statuses.map((status) => `'${status}'`).join(',');
}
