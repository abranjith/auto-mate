// Shared shapes for the seven checks (FEAT-107). Each check returns one of
// these; `VerificationService` collects them and the repository writes them in
// one transaction. Findings carry VERSION-RELATIVE paths only: they are
// rendered in a browser and stored in a row an export will carry.

import path from 'node:path';
import { MAX_FINDINGS_PER_CHECK, isBlockingFinding, type CheckKey, type CheckStatus, type FindingConfidence, type FindingSeverity } from '@automate/core';
import type { NewCheck, NewFinding } from '../../db/repositories/verification-repository';

/** What one check produced, before it is written. */
export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly findings: readonly NewFinding[];
  readonly summary: string;
  readonly detail?: unknown;
  readonly durationMs: number | null;
}

/** A finding before the gate policy has resolved whether it blocks. */
export interface RawFinding {
  readonly ruleCode: string;
  readonly severity: FindingSeverity;
  readonly confidence: FindingConfidence | null;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
}

/** Resolve `isBlocking` through the one gate policy, never inline. */
export function resolveFinding(checkKey: CheckKey, finding: RawFinding): NewFinding {
  return { ...finding, isBlocking: isBlockingFinding({ checkKey, ruleCode: finding.ruleCode, severity: finding.severity, confidence: finding.confidence }) };
}

/**
 * Keep at most `MAX_FINDINGS_PER_CHECK` findings, blocking ones first, so the cap can never hide what blocks.
 * @returns The kept findings and how many were dropped.
 */
export function capFindings(findings: readonly NewFinding[], limit = MAX_FINDINGS_PER_CHECK): { kept: NewFinding[]; overflow: number } {
  const ordered = [...findings.filter(({ isBlocking }) => isBlocking), ...findings.filter(({ isBlocking }) => !isBlocking)];
  return { kept: ordered.slice(0, limit), overflow: Math.max(0, ordered.length - limit) };
}

/**
 * Reduce a tool-reported path to its form relative to the version directory.
 *
 * Tools report absolute paths, on Windows with mixed separators. A path that
 * is not inside the version directory is reduced to its basename, so an
 * absolute path can never leave this function.
 *
 * @param versionDir The absolute directory the tool inspected.
 * @param reported The path the tool printed.
 * @returns A forward-slash relative path, or null when nothing usable was given.
 */
export function versionRelative(versionDir: string, reported: unknown): string | null {
  if (typeof reported !== 'string' || reported.length === 0) return null;
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = normalize(path.resolve(versionDir));
  const target = normalize(path.isAbsolute(reported) ? path.resolve(reported) : path.resolve(versionDir, reported));
  const insensitive = process.platform === 'win32';
  const within = (insensitive ? target.toLowerCase() : target).startsWith(`${insensitive ? root.toLowerCase() : root}/`);
  const relative = within ? target.slice(root.length + 1) : target.split('/').pop() ?? '';
  return relative.length === 0 || relative.split('/').includes('..') ? null : relative;
}

/** Name a count: `1 finding`, `2 findings`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Turn an outcome into the repository's row shape. */
export function toNewCheck(checkKey: CheckKey, outcome: CheckOutcome, isBlocking: boolean): NewCheck {
  return { checkKey, status: outcome.status, isBlocking, summary: outcome.summary, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }), durationMs: outcome.durationMs, findings: outcome.findings };
}

/** A check that could not run: `errored`, no findings, and a plain-English reason. It blocks. */
export function erroredOutcome(summary: string, durationMs: number | null, detail?: unknown): CheckOutcome {
  return { status: 'errored', findings: [], summary, durationMs, ...(detail === undefined ? {} : { detail }) };
}
