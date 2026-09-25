// ---------------------------------------------------------------------------
// The output manifest (FEAT-107 TASK-001).
//
// `manifest.json` is written by generated code: UNTRUSTED. The parser is
// tolerant and total — it returns null for anything that is not a valid
// declaration and never throws, because a script that wrote nonsense is a
// failed run to explain, not a crashed server. Filenames are validated as
// plain relative names; they are labels to match against files on disk, never
// paths to join.
// ---------------------------------------------------------------------------

import { ARTIFACT_TYPES, type ArtifactType } from '../contracts/generation-api';

/** One declared output, in memory's manifest shape. */
export interface ManifestEntry {
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly description: string;
}

/** A parsed, valid manifest. */
export interface OutputManifest {
  readonly artifacts: readonly ManifestEntry[];
}

/** How the declaration and the output directory compare. */
export interface OutputReconciliation {
  readonly declaredCount: number;
  readonly producedCount: number;
  /** Declared filenames with no file on disk. */
  readonly missing: readonly string[];
  /** Files on disk nobody declared (the manifest itself excluded). */
  readonly undeclared: readonly string[];
}

const MAX_FILENAME = 255;

/**
 * Whether a declared filename is a plain relative name: no separator, no `..`, no drive, no control characters.
 *
 * @param name A model-declared filename.
 * @returns True when it can only name a file directly inside the output directory.
 * @example isPlainFilename('totals.csv') // true
 */
export function isPlainFilename(name: string): boolean {
  if (name.length === 0 || name.length > MAX_FILENAME) return false;
  if (name === '.' || name === '..' || name.includes('..')) return false;
  if (/[\\/:]/.test(name)) return false;
  return ![...name].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}

function entryOf(value: unknown): ManifestEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const { filename, type, title, description } = item;
  if (typeof filename !== 'string' || !isPlainFilename(filename)) return null;
  if (typeof type !== 'string' || !(ARTIFACT_TYPES as readonly string[]).includes(type)) return null;
  return { filename, type: type as ArtifactType, title: typeof title === 'string' ? title : filename, description: typeof description === 'string' ? description : '' };
}

/**
 * Parse a manifest. Never throws.
 *
 * @param text The raw file content.
 * @returns The manifest, or null for invalid JSON, a missing `artifacts` array, or any invalid entry.
 * @example parseOutputManifest('{"artifacts":[{"filename":"a.csv","type":"csv","title":"A","description":""}]}')
 */
export function parseOutputManifest(text: string): OutputManifest | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const artifacts = (parsed as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return null;
  const entries: ManifestEntry[] = [];
  for (const raw of artifacts) {
    const entry = entryOf(raw);
    if (!entry) return null;
    entries.push(entry);
  }
  return { artifacts: entries };
}

/**
 * Compare declared outputs with the files actually present.
 *
 * @param declared Declared filenames.
 * @param produced Filenames found in the output directory.
 * @returns Counts plus what is missing and what nobody declared; `manifest.json` never counts as produced.
 * @example reconcileOutputs(['a.csv'], ['a.csv', 'manifest.json']).missing // []
 */
export function reconcileOutputs(declared: readonly string[], produced: readonly string[]): OutputReconciliation {
  const files = produced.filter((name) => name !== 'manifest.json');
  const present = new Set(files);
  const named = new Set(declared);
  return { declaredCount: declared.length, producedCount: files.length, missing: declared.filter((name) => !present.has(name)), undeclared: files.filter((name) => !named.has(name)) };
}
