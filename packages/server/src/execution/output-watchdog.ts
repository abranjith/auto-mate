import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { OUTPUT_WATCH_INTERVAL_MS, type LimitBreach } from '@automate/core';

export interface OutputWatchLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly intervalMs?: number;
}

export interface OutputUsage { readonly bytes: number; readonly files: number; readonly breach: LimitBreach | null }

/** Count regular files without following symlinks or traversing unbounded depth. */
export function inspectOutput(dir: string, limits: OutputWatchLimits): OutputUsage {
  const pending = [{ dir, depth: 0 }];
  let bytes = 0;
  let files = 0;
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 32) return { bytes, files, breach: 'output_files' };
    let children: Dirent<string>[];
    try { children = readdirSync(current.dir, { withFileTypes: true }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue; throw cause; }
    for (const child of children) {
      if (++entries > 100_000) return { bytes, files, breach: 'output_files' };
      const childPath = path.join(current.dir, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) { pending.push({ dir: childPath, depth: current.depth + 1 }); continue; }
      if (!child.isFile()) continue;
      try {
        const stat = lstatSync(childPath);
        if (!stat.isFile()) continue;
        files += 1;
        bytes += stat.size;
        if (limits.maxFiles > 0 && files > limits.maxFiles) return { bytes, files, breach: 'output_files' };
        if ((limits.maxFileBytes > 0 && stat.size > limits.maxFileBytes) || (limits.maxTotalBytes > 0 && bytes > limits.maxTotalBytes)) return { bytes, files, breach: 'output_bytes' };
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    }
  }
  return { bytes, files, breach: null };
}

/** Poll output usage until a cap is crossed or the caller stops watching. */
export function watchOutput(dir: string, limits: OutputWatchLimits, signal: AbortSignal): Promise<LimitBreach | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(null); return; }
    let done = false;
    const finish = (value: LimitBreach | null) => { if (done) return; done = true; clearInterval(timer); signal.removeEventListener('abort', abort); resolve(value); };
    const abort = () => finish(null);
    const poll = () => { try { const result = inspectOutput(dir, limits); if (result.breach) finish(result.breach); } catch (cause) { if (!done) { done = true; clearInterval(timer); signal.removeEventListener('abort', abort); reject(cause); } } };
    const timer = setInterval(poll, limits.intervalMs ?? OUTPUT_WATCH_INTERVAL_MS);
    signal.addEventListener('abort', abort, { once: true });
    poll();
  });
}
