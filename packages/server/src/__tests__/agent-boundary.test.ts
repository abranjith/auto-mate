/**
 * Architectural boundary enforcement for FEAT-102.
 *
 * The scan is source-text based on purpose: it holds regardless of tsconfig
 * project membership, so it catches a file that no build includes — which is
 * exactly how an SDK import sneaks back in.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';
/** The one directory allowed to import the SDK, plus the deliberate-violation fixture's home. */
const ALLOWED_PREFIXES = ['packages/server/src/agent/adapters/pi/'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.tanstack']);

/** Collect every TypeScript source file under a root. */
function collectSources(root: string, collected: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return collected; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) collectSources(full, collected); continue; }
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) collected.push(full);
  }
  return collected;
}

/** Match a static import, a re-export, a dynamic `import()`, and a `require()` of one package. */
export function importsPackage(sourceText: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const specifier = `['"]${escaped}(?:\\/[^'"]*)?['"]`;
  return [
    new RegExp(`(?:import|export)[^'"]*?from\\s*${specifier}`),
    new RegExp(`import\\s*${specifier}`),
    new RegExp(`import\\s*\\(\\s*${specifier}\\s*\\)`),
    new RegExp(`require\\s*\\(\\s*${specifier}\\s*\\)`),
  ].some((pattern) => pattern.test(sourceText));
}

/** Repo-relative, forward-slashed path, so the assertions read the same on both platforms. */
function normalize(file: string): string {
  return path.relative(repoRoot, file).replace(/\\/g, '/');
}

/** This file itself, which carries synthetic violation samples on purpose. */
const SELF = 'packages/server/src/__tests__/agent-boundary.test.ts';

/** Every file in the workspace that references the SDK at all, excluding this scanner. */
function sdkImporters(): string[] {
  return collectSources(path.join(repoRoot, 'packages'))
    .filter((file) => importsPackage(readFileSync(file, 'utf8'), PI_SDK_PACKAGE))
    .map(normalize)
    .filter((file) => file !== SELF)
    .sort();
}

describe('agent SDK boundary', () => {
  it('confines the Pi SDK to the adapter directory', () => {
    const offenders = sdkImporters().filter((file) => !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) && !file.includes('/__fixtures__/'));
    // A non-empty list means the SDK leaked out from behind the seam.
    expect(offenders).toEqual([]);
  });

  it('reports the deliberate-violation fixture when the allowlist is emptied, proving the scan can fail', () => {
    const offenders = sdkImporters().filter((file) => ![].some((prefix: string) => file.startsWith(prefix)));
    expect(offenders).toContain('packages/core/src/agent/__fixtures__/pi-sdk-import-outside-adapter.ts');
    expect(offenders.length).toBeGreaterThan(1);
  });

  it('keeps packages/core and packages/web free of any SDK reference', () => {
    const offenders = sdkImporters().filter((file) => (file.startsWith('packages/core/') || file.startsWith('packages/web/')) && !file.includes('/__fixtures__/'));
    expect(offenders).toEqual([]);
  });

  it.each([
    ["import { createAgentSession } from '@earendil-works/pi-coding-agent';", 'a static import'],
    ["export { createAgentSession } from '@earendil-works/pi-coding-agent';", 'a re-export'],
    ["const sdk = await import('@earendil-works/pi-coding-agent');", 'a dynamic import'],
    ["const sdk = require('@earendil-works/pi-coding-agent');", 'a require call'],
    ["import type { X } from '@earendil-works/pi-coding-agent/sub/path';", 'a subpath import'],
    ["import '@earendil-works/pi-coding-agent';", 'a bare side-effect import'],
  ])('detects %s (%s)', (source) => {
    expect(importsPackage(source, PI_SDK_PACKAGE)).toBe(true);
  });

  it.each([
    "import { createAgentProvider } from '../agent/index';",
    "// mentions @earendil-works/pi-coding-agent only in prose",
    "import { x } from '@earendil-works/pi-coding-agent-lookalike';",
  ])('does not flag %s', (source) => {
    expect(importsPackage(source, PI_SDK_PACKAGE)).toBe(false);
  });

  it('scans a non-trivial number of files, so an empty offender list means something', () => {
    expect(collectSources(path.join(repoRoot, 'packages')).length).toBeGreaterThan(30);
  });
});
