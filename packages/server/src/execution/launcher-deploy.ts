import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LauncherIntegrityError } from '@automate/core';
import { resolveWithin } from '../config/app-paths';

export const LAUNCHER_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runtime/launcher/automate_launch.py');
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Copy the trusted launcher from the repository; its digest is stored with readiness. */
export function deployLauncher(envDir: string, source = LAUNCHER_SOURCE): { path: string; digest: string } {
  mkdirSync(envDir, { recursive: true });
  const destination = resolveWithin(envDir, 'automate_launch.py');
  const digest = sha256(source);
  if (!existsSync(destination) || sha256(destination) !== digest) copyFileSync(source, destination);
  return { path: destination, digest };
}

/** Check the exact launcher bytes immediately before a script starts. */
export function verifyLauncher(envDir: string, expectedDigest: string): string {
  const destination = resolveWithin(envDir, 'automate_launch.py');
  if (!existsSync(destination) || sha256(destination) !== expectedDigest) throw new LauncherIntegrityError();
  return destination;
}
