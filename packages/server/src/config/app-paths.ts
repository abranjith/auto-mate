import { accessSync, mkdirSync, statSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigurationError, ValidationError } from '@automate/core';

export interface AppPaths {
  root: string;
  dataDir: string;
  dbFile: string;
  artifactsDir: string;
  uploadsDir: string;
  /** Uploads not yet claimed by a task: `uploads/staged/<uploadId>/` (FEAT-104). */
  stagedUploadsDir: string;
  scriptsDir: string;
  envDir: string;
  /** The checker uv project (FEAT-107): ruff and bandit, kept apart from the code they check. */
  verifyEnvDir: string;
  /** Real-data runs (FEAT-107): `runs/{executionId}/{input,output,verify}`. */
  runsDir: string;
  configDir: string;
  agentConfigFile: string;
  piDir: string;
  piAuthFile: string;
  piModelsFile: string;
  piSessionStagingDir: string;
  agentSessionsDir: string;
  /** Resolve the session directory for one execution, guarded against traversal. */
  sessionDirFor(executionId: string): string;
  /** Resolve a task's upload directory, `uploads/<taskId>/`, guarded against traversal (FEAT-104). */
  uploadsDirForTask(taskId: number): string;
}

/** Resolve the configured data root and all durable child directories. @param home Optional root override. @returns Absolute paths for application storage. */
export function getAppPaths(home = process.env.AUTOMATE_HOME): AppPaths {
  const configured = home?.trim() || path.join(homedir(), '.automate');
  const expanded = configured === '~' ? homedir() : /^~[\\/]/.test(configured) ? path.join(homedir(), configured.slice(2)) : configured;
  const root = path.resolve(expanded);
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  const piDir = path.join(root, 'pi');
  const agentSessionsDir = path.join(root, 'agent-sessions');
  const uploadsDir = path.join(root, 'uploads');
  return {
    root, dataDir, dbFile: path.join(dataDir, 'automate.db'),
    artifactsDir: path.join(root, 'artifacts'), uploadsDir, stagedUploadsDir: path.join(uploadsDir, 'staged'),
    scriptsDir: path.join(root, 'scripts'), envDir: path.join(root, 'env'),
    verifyEnvDir: path.join(root, 'verify-env'), runsDir: path.join(root, 'runs'),
    configDir, agentConfigFile: path.join(configDir, 'agent.json'),
    piDir, piAuthFile: path.join(piDir, 'auth.json'), piModelsFile: path.join(piDir, 'models.json'),
    piSessionStagingDir: path.join(piDir, 'sessions'), agentSessionsDir,
    sessionDirFor: (executionId: string) => resolveWithin(agentSessionsDir, executionId),
    uploadsDirForTask: (taskId: number) => {
      if (!Number.isSafeInteger(taskId) || taskId < 1) throw new ValidationError('The task id must be a positive integer.');
      return resolveWithin(uploadsDir, String(taskId));
    },
  };
}

/** Resolve a user path inside a base directory. @param base Allowed base. @param segments Child path parts. @returns The absolute child path. @throws ValidationError when the result escapes the base. */
export function resolveWithin(base: string, ...segments: string[]): string {
  const root = path.resolve(base);
  const destination = path.resolve(segments.reduce((current, segment) => path.isAbsolute(segment) ? segment : path.join(current, segment), root));
  const relative = path.relative(root, destination);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError('The requested path is outside the application directory.');
  }
  return destination;
}

/** Create the durable storage layout. @param paths Resolved application paths. @returns Nothing; creates directories. @throws ConfigurationError when storage is unavailable. */
export function ensureAppDirectories(paths: AppPaths): void {
  try {
    mkdirSync(paths.root, { recursive: true });
    if (!statSync(paths.root).isDirectory()) throw new Error('not a directory');
    accessSync(paths.root, constants.W_OK);
    for (const directory of [paths.dataDir, paths.artifactsDir, paths.uploadsDir, paths.stagedUploadsDir, paths.scriptsDir, paths.envDir, paths.verifyEnvDir, paths.runsDir, paths.configDir, paths.agentSessionsDir]) {
      mkdirSync(directory, { recursive: true });
      accessSync(directory, constants.W_OK);
    }
    // The Pi directory holds the managed credential store, so it is created
    // restrictively. The mode is a best-effort no-op on filesystems without
    // POSIX permissions.
    for (const directory of [paths.piDir, paths.piSessionStagingDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      accessSync(directory, constants.W_OK);
    }
  } catch (cause) {
    throw new ConfigurationError('The application data directory cannot be created or written. Check AUTOMATE_HOME.', cause);
  }
}
