import { lstat, rm, unlink } from 'node:fs/promises';
import { resolveWithin } from '../config/app-paths';

/** Remove a numeric owned entry without following a link or junction outside its root. */
export async function removeTree(base: string, name: string): Promise<{ removed: boolean; code?: string }> {
  if (!/^\d+$/.test(name)) return { removed: false, code: 'INVALID_NAME' };
  const target = resolveWithin(base, name);
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) await unlink(target);
    else await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { removed: true };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? { removed: true } : { removed: false, code };
  }
}
