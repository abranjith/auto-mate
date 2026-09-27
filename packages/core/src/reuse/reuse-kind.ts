export const REUSE_KINDS = ['run', 'replay', 'repair'] as const;
export type ReuseKind = (typeof REUSE_KINDS)[number];

/** Identify a run that executes saved code without opening an agent session.
 * @param kind The run's reuse kind, if any.
 * @returns True for a saved-code run or historical replay.
 * @example isSavedCodeRun('replay')
 */
export function isSavedCodeRun(kind: ReuseKind | null | undefined): boolean {
  return kind === 'run' || kind === 'replay';
}
