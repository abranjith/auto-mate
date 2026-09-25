// Recognize a SQLite constraint violation through drizzle's error wrapping
// (drizzle raises "Failed query: …" with the driver error as `cause`).

/**
 * Whether an error, or any error in its `cause` chain, is a UNIQUE constraint violation.
 * @param error Anything thrown by a query.
 * @returns True for `UNIQUE constraint failed`.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (/UNIQUE constraint failed/i.test(String((current as { message?: unknown }).message ?? ''))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
