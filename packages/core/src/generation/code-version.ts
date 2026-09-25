// ---------------------------------------------------------------------------
// Code versions (FEAT-106 TASK-001).
//
// A `code_version` is one candidate script, sealed and immutable. Its
// `content_digest` is the identity FEAT-107 binds verification results to and
// FEAT-108 executes: "which exact code was checked" is answered by comparing
// digests, not by trusting the order writes happened in. That only works if
// server and browser compute the digest identically, so the definition lives
// here, browser-safe, and nowhere else.
// ---------------------------------------------------------------------------

import { canonicalStringify } from '../disclosure/canonical-json';
import { sha256Hex } from './sha256';

/** `draft` is mutable and has no digest; every other status is sealed and immutable. */
export const CODE_VERSION_STATUSES = ['draft', 'sealed', 'tested_pass', 'tested_fail', 'superseded'] as const;
export type CodeVersionStatus = (typeof CODE_VERSION_STATUSES)[number];

/** What a file is for. Only `script` files may be an entrypoint; `test` files are what pytest collects. */
export const CODE_FILE_ROLES = ['script', 'test', 'support'] as const;
export type CodeFileRole = (typeof CODE_FILE_ROLES)[number];

/** The two facts about a file that a version digest covers. */
export interface DigestInput {
  readonly path: string;
  readonly sha256: string;
}

/**
 * Compute a code version's identity from its file set.
 *
 * The digest is SHA-256 over the canonical JSON of `[{path, sha256}]` sorted
 * by path, so the order files were written in never matters and one changed
 * byte in any file changes the result.
 *
 * @param files Every file in the version, each with its own lowercase hex SHA-256.
 * @returns The version's lowercase hex SHA-256.
 * @example computeVersionDigest([{ path: 'main.py', sha256: 'ab…' }])
 */
export function computeVersionDigest(files: readonly DigestInput[]): string {
  const entries = files
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return sha256Hex(canonicalStringify(entries));
}

/**
 * Count the lines a person would see in an editor.
 *
 * @param content File text.
 * @returns 0 for an empty file; a trailing newline does not add a line.
 * @example countLines('a\nb\n') // 2
 */
export function countLines(content: string): number {
  if (content === '') return 0;
  const breaks = content.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(content) ? breaks - 1 : breaks;
}

/**
 * Shorten a digest for display. Never use the short form to identify code.
 *
 * @param digest A 64-character hex digest.
 * @returns Its first 12 characters.
 * @example shortDigest('0123456789abcdef…') // '0123456789ab'
 */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
