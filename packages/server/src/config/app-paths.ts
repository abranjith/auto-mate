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
  scriptsDir: string;
  envDir: string;
}

/** Resolve the configured data root and all durable child directories. @param home Optional root override. @returns Absolute paths for application storage. */
export function getAppPaths(home = process.env.AUTOMATE_HOME): AppPaths {
  const configured = home?.trim() || path.join(homedir(), '.automate');
  const expanded = configured === '~' ? homedir() : /^~[\\/]/.test(configured) ? path.join(homedir(), configured.slice(2)) : configured;
  const root = path.resolve(expanded);
  const dataDir = path.join(root, 'data');
  return {
    root, dataDir, dbFile: path.join(dataDir, 'automate.db'),
    artifactsDir: path.join(root, 'artifacts'), uploadsDir: path.join(root, 'uploads'),
    scriptsDir: path.join(root, 'scripts'), envDir: path.join(root, 'env'),
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
    for (const directory of [paths.dataDir, paths.artifactsDir, paths.uploadsDir, paths.scriptsDir, paths.envDir]) {
      mkdirSync(directory, { recursive: true });
      accessSync(directory, constants.W_OK);
    }
  } catch (cause) {
    throw new ConfigurationError('The application data directory cannot be created or written. Check AUTOMATE_HOME.', cause);
  }
}
