// ---------------------------------------------------------------------------
// Runtime fingerprint (FEAT-107 TASK-001).
//
// The other half of the verification binding. A `verification_run` stores the
// digest of the code it checked AND this fingerprint of the runtime it was
// checked on; upgrade Python, uv, or one package and the fingerprint moves, so
// the old result stops covering the run. `describeRuntimeChange` turns a
// mismatch into the concrete sentences a person needs instead of a hash.
// ---------------------------------------------------------------------------

import { canonicalStringify } from '../disclosure/canonical-json';
import { sha256Hex } from '../generation/sha256';

/** One installed package. */
export interface RuntimePackage {
  readonly name: string;
  readonly version: string;
}

/** Everything the fingerprint covers. Stored verbatim as `runtime_detail`. */
export interface RuntimeDetail {
  readonly pythonVersion: string;
  readonly uvVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly packages: readonly RuntimePackage[];
}

const byName = (left: RuntimePackage, right: RuntimePackage) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

/**
 * Put a runtime detail in canonical form: packages lowercased by name and sorted.
 *
 * @param detail A probed runtime.
 * @returns The same facts with a stable package order.
 * @example normalizeRuntimeDetail({ ...detail, packages: [{ name: 'Pandas', version: '2.3.1' }] })
 */
export function normalizeRuntimeDetail(detail: RuntimeDetail): RuntimeDetail {
  const packages = detail.packages.map(({ name, version }) => ({ name: name.toLowerCase(), version })).sort(byName);
  return { pythonVersion: detail.pythonVersion, uvVersion: detail.uvVersion, platform: detail.platform, arch: detail.arch, packages };
}

/**
 * Fingerprint a runtime.
 *
 * @param detail Interpreter, uv, platform, architecture, and every installed package.
 * @returns Lowercase hex SHA-256 over the canonical JSON; independent of package order.
 * @example computeRuntimeFingerprint({ pythonVersion: '3.12.4', uvVersion: 'uv 0.8.0', platform: 'linux', arch: 'x64', packages: [] })
 */
export function computeRuntimeFingerprint(detail: RuntimeDetail): string {
  return sha256Hex(canonicalStringify(normalizeRuntimeDetail(detail)));
}

/**
 * Explain what changed between two runtimes.
 *
 * @param before The runtime a verification was bound to.
 * @param after The runtime probed now.
 * @returns One sentence per change, for example `Python changed from 3.12.4 to 3.13.1`; empty when nothing changed.
 * @example describeRuntimeChange(a, { ...a, pythonVersion: '3.13.1' }) // ['Python changed from 3.12.4 to 3.13.1']
 */
export function describeRuntimeChange(before: RuntimeDetail, after: RuntimeDetail): string[] {
  const changes: string[] = [];
  const field = (label: string, from: string, to: string) => { if (from !== to) changes.push(`${label} changed from ${from} to ${to}`); };
  field('Python', before.pythonVersion, after.pythonVersion);
  field('uv', before.uvVersion, after.uvVersion);
  field('The platform', `${before.platform} ${before.arch}`, `${after.platform} ${after.arch}`);
  const old = new Map(normalizeRuntimeDetail(before).packages.map(({ name, version }) => [name, version]));
  const now = new Map(normalizeRuntimeDetail(after).packages.map(({ name, version }) => [name, version]));
  for (const [name, version] of now) {
    const previous = old.get(name);
    if (previous === undefined) changes.push(`${name} ${version} was added`);
    else if (previous !== version) changes.push(`${name} changed from ${previous} to ${version}`);
  }
  for (const [name, version] of old) if (!now.has(name)) changes.push(`${name} ${version} was removed`);
  return changes;
}

/**
 * Name a runtime for a person.
 *
 * @param detail A probed runtime.
 * @returns For example `Python 3.12.4 on Linux (x64)`.
 * @example describeRuntime(detail) // 'Python 3.12.4 on Linux (x64)'
 */
export function describeRuntime(detail: RuntimeDetail): string {
  const names: Readonly<Record<string, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return `Python ${detail.pythonVersion} on ${names[detail.platform] ?? detail.platform} (${detail.arch})`;
}
