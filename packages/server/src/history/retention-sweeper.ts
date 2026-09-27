// Task data lives for the life of the task, with no age-based purge. This
// sweep cleans orphans left by crashes or interrupted deletion; it is not retention.
import { readdir } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import type { HistoryRepository } from '../db/repositories/history-repository';
import type { DisclosureConsentRepository } from '../db/repositories/disclosure-consent-repository';
import { TASK_OWNED_TREES } from './task-owned-trees';
import { removeTree } from './safe-remove';

/** Sweeps orphaned per-execution trees and abandoned staged-file consents. */
export class RetentionSweeper {
  private current: Promise<{ treesRemoved: number; treesPending: number; consentsRemoved: number }> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly deps: { paths: AppPaths; history: HistoryRepository; consents: DisclosureConsentRepository; ttlHours: number; logger: Pick<Logger, 'info' | 'warn'>; now?: () => Date }) {}

  /** Run one sweep, shared by concurrent callers. */
  sweep(): Promise<{ treesRemoved: number; treesPending: number; consentsRemoved: number }> {
    if (this.current) return this.current;
    this.current = this.perform().finally(() => { this.current = undefined; });
    return this.current;
  }

  /** Schedule an unref'd hourly orphan sweep. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch((cause: unknown) => this.deps.logger.warn({ code: (cause as { code?: string }).code ?? 'UNKNOWN' }, 'retention sweep failed')); }, 60 * 60 * 1000);
    this.timer.unref();
  }
  /** Stop the periodic sweep during shutdown. */
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private async perform() {
    let treesRemoved = 0; let treesPending = 0;
    for (const tree of TASK_OWNED_TREES.filter((entry) => entry.keyedBy === 'execution')) {
      const root = tree.root(this.deps.paths);
      const entries = await readdir(root).catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return []; throw cause; });
      for (const name of entries) {
        if (!/^\d+$/.test(name) || (Number.isSafeInteger(Number(name)) && this.deps.history.executionExists(Number(name)))) continue;
        const result = await removeTree(root, name);
        if (result.removed) treesRemoved += 1;
        else { treesPending += 1; this.deps.logger.warn({ kind: tree.kind, code: result.code }, 'orphan tree pending removal'); }
      }
    }
    const cutoff = new Date((this.deps.now?.() ?? new Date()).getTime() - this.deps.ttlHours * 60 * 60 * 1000);
    const consentsRemoved = this.deps.consents.deleteUnattachedBefore(cutoff);
    this.deps.logger.info({ treesRemoved, treesPending, consentsRemoved }, 'retention orphan sweep completed');
    return { treesRemoved, treesPending, consentsRemoved };
  }
}
