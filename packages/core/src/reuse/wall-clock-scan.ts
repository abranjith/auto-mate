/** Best-effort warning, never a gate. Aliased imports can escape this scan; comments can match. */
export const WALL_CLOCK_PATTERNS = [
  /\bdatetime\.(?:now|today|utcnow)\s*\(/,
  /\bdate\.today\s*\(/,
  /\b(?:pd|pandas)\.Timestamp\.(?:now|today)\s*\(/,
  /\bto_datetime\s*\(\s*['"](?:now|today)['"]/,
  /\bnp\.datetime64\s*\(\s*['"](?:now|today)['"]/,
  /\btime\.(?:localtime|strftime)\s*\(/,
] as const;

/** Locate direct clock reads in executable code, excluding tests.
 * @param files Code files with path, role, and content.
 * @returns Matched file paths, line numbers, and patterns.
 * @example findWallClockReads([{ path: 'main.py', role: 'script', content: 'date.today()' }])
 */
export function findWallClockReads(files: readonly { readonly path: string; readonly role: string; readonly content: string }[]): { path: string; line: number; pattern: string }[] {
  const reads: { path: string; line: number; pattern: string }[] = [];
  for (const file of files.filter((item) => item.role === 'script' || item.role === 'support')) {
    file.content.split(/\r?\n/).forEach((line, index) => {
      for (const pattern of WALL_CLOCK_PATTERNS) if (pattern.test(line)) reads.push({ path: file.path, line: index + 1, pattern: pattern.source });
    });
  }
  return reads;
}
