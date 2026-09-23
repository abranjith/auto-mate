/**
 * Session file placement under the application data root (FEAT-102 TASK-005).
 *
 * `SessionManager.create(cwd, sessionDir)` writes the session JSONL directly at
 * its FINAL location, so there is no relocate-on-close step: `logPath` is
 * correct from the moment the session opens, and a crashed process still leaves
 * the artifact where later features expect it.
 *
 * File hygiene: the directory is created `0o700` and the file is chmod-ed
 * `0o600` at finalize. Both are best-effort no-ops on filesystems without POSIX
 * permissions.
 */

import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

/** Options for {@link createAgentSessionFile}. */
export interface AgentSessionFileOptions {
  /** Absolute directory the session JSONL is written into. */
  readonly sessionDir: string;
  /** Working directory recorded in the session header. */
  readonly cwd: string;
}

/** A Pi session manager pinned to one execution's session directory. */
export interface AgentSessionFile {
  /** The SDK session manager to hand to `createAgentSession`. */
  readonly sessionManager: SessionManager;
  /** The directory the session JSONL lives in. */
  readonly sessionDir: string;
  /** Absolute path of the session JSONL. This is the final location. @returns The path reported as `AgentSession.logPath`. @example file.logPath() */
  logPath(): string;
  /** Guarantee the artifact exists and restrict its permissions. @returns Nothing; idempotent, and resolves even when chmod is unsupported. @example await file.finalize() */
  finalize(): Promise<void>;
}

/**
 * Create a Pi `SessionManager` whose session file lives under `sessionDir`.
 *
 * @param options The session directory and the working directory to record.
 * @returns The session file handle with its manager, path, and finalizer.
 * @example await createAgentSessionFile({ sessionDir: paths.sessionDirFor(executionId), cwd })
 */
export async function createAgentSessionFile(options: AgentSessionFileOptions): Promise<AgentSessionFile> {
  const { sessionDir } = options;
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const sessionManager = SessionManager.create(options.cwd, sessionDir);

  const logPath = (): string => {
    // `create()` assigns a file path whenever a session directory is set; the
    // fallback keeps `logPath` total if the SDK ever stops doing that.
    return sessionManager.getSessionFile() ?? path.join(sessionDir, `${sessionManager.getSessionId()}.jsonl`);
  };

  const finalize = async (): Promise<void> => {
    const file = logPath();
    if (!existsSync(file)) {
      // The SDK flushes lazily: a session that produced no output would leave
      // no file at all. Persist the header so the artifact always exists.
      const header = sessionManager.getHeader();
      if (header !== null) await appendFile(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    try { await chmod(file, 0o600); }
    catch { /* chmod is unsupported on Windows and some filesystems; the artifact is still written. */ }
  };

  return { sessionManager, sessionDir, logPath, finalize };
}
