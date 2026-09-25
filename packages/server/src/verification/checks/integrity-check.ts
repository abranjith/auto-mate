// ---------------------------------------------------------------------------
// The integrity check (FEAT-107 TASK-007): the one that must pass before any
// other result means anything. Three comparisons, each between a fact the
// application recomputes now and a fact it recorded earlier:
//
//   1. every stored file's SHA-256, recomputed from its stored content;
//   2. the version digest, recomputed with FEAT-106's `computeVersionDigest`;
//   3. each synthetic fixture, re-derived from the profile and the RECORDED
//      seed, against its recorded SHA-256 — which also proves FEAT-106's
//      generator is deterministic.
//
// The files are then re-projected to disk from the database, so what the
// other checks inspect is exactly what was digested (disk is a projection).
// Checking code whose bytes do not match its digest would produce results
// bound to nothing, so the pass stops here when this fails.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { AutoMateError, computeVersionDigest, type CodeFileRole } from '@automate/core';
import type { CodeVersionWithFiles } from '../../db/repositories/code-version-repository';
import type { SyntheticFixtureRow } from '../../db/repositories/synthetic-fixture-repository';
import type { FixtureService } from '../../generation/fixture-service';
import { plural, resolveFinding, type CheckOutcome, type RawFinding } from './check-result';

export interface IntegrityDependencies {
  /** FEAT-106's workspace projection: writes a sealed version's files from the database. @returns The absolute attempt directory. */
  readonly project: (versionId: number) => string;
  readonly fixtures: Pick<FixtureService, 'rebuild'>;
}

/** What the test re-run needs from a passed integrity check. */
export interface RebuiltFixtures {
  readonly directory: string;
  readonly files: readonly { readonly uploadId: number; readonly sha256: string; readonly rowCount: number }[];
}

export interface IntegrityResult {
  readonly outcome: CheckOutcome;
  readonly versionDir: string | null;
  readonly fixtures: RebuiltFixtures | null;
}

const finding = (ruleCode: string, filePath: string | null, message: string): RawFinding => ({ ruleCode, severity: 'high', confidence: null, filePath, line: null, column: null, message });

/** Comparisons 1 and 2: stored bytes against stored digests. */
function codeFindings(version: CodeVersionWithFiles): RawFinding[] {
  const found: RawFinding[] = [];
  const recomputed = version.files.map((file) => ({ path: file.path, sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'), stored: file.sha256 }));
  for (const file of recomputed) if (file.sha256 !== file.stored) found.push(finding('file_digest_mismatch', file.path, `${file.path} no longer matches the fingerprint recorded when it was saved, so it may have been changed after it was sealed.`));
  if (version.contentDigest === null || computeVersionDigest(recomputed) !== version.contentDigest) found.push(finding('digest_mismatch', null, 'The code does not match the fingerprint recorded for this version, so these files are not the files that were sealed.'));
  return found;
}

/** Comparison 3: each fixture re-derived into `directory` and compared with its record. */
async function fixtureFindings(deps: IntegrityDependencies, recorded: readonly SyntheticFixtureRow[], directory: string): Promise<{ findings: RawFinding[]; files: RebuiltFixtures['files'] }> {
  const findings: RawFinding[] = [];
  const files: { uploadId: number; sha256: string; rowCount: number }[] = [];
  for (const [index, fixture] of recorded.entries()) {
    try {
      const rebuilt = await deps.fixtures.rebuild(fixture, directory);
      files.push({ uploadId: fixture.uploadId, sha256: rebuilt.sha256, rowCount: rebuilt.rowCount });
      if (rebuilt.sha256 !== fixture.sha256) findings.push(finding('fixture_not_reproducible', null, `The synthetic test data for file ${index + 1} could not be reproduced exactly, so the earlier test result describes a run nobody can repeat.`));
    } catch (cause) {
      const reason = cause instanceof AutoMateError ? cause.message : 'it could not be rebuilt';
      findings.push(finding('fixture_not_reproducible', null, `The synthetic test data for file ${index + 1} could not be rebuilt: ${reason}`));
    }
  }
  return { findings, files };
}

/**
 * Run the integrity check.
 * @param version The sealed, final version with its stored files.
 * @param recorded The synthetic fixtures its tests ran against.
 * @param fixtureDir A FRESH directory to rebuild the fixtures into; the test re-run reuses them.
 * @returns The outcome, the projected version directory, and the rebuilt fixtures (null when integrity failed).
 */
export async function runIntegrityCheck(deps: IntegrityDependencies, version: CodeVersionWithFiles, recorded: readonly SyntheticFixtureRow[], fixtureDir: string): Promise<IntegrityResult> {
  const started = performance.now();
  rmSync(fixtureDir, { recursive: true, force: true });
  const code = codeFindings(version);
  const fixtures = await fixtureFindings(deps, recorded, fixtureDir);
  const raw = [...code, ...fixtures.findings];
  const findings = raw.map((item) => resolveFinding('integrity', item));
  const durationMs = Math.round(performance.now() - started);
  const detail = { fileCount: version.files.length, fixtureCount: recorded.length, fixtures: fixtures.files.map(({ uploadId, sha256 }) => ({ uploadId, sha256 })) };
  if (findings.length > 0) return { outcome: { status: 'failed', findings, summary: `${plural(findings.length, 'integrity problem')}: the code or its test data does not match what was recorded`, detail, durationMs }, versionDir: null, fixtures: null };
  // Disk is a projection: rewrite the files from the rows just verified, rebuilding a missing directory.
  const versionDir = deps.project(version.id);
  const scripts = version.files.filter(({ role }) => (role as CodeFileRole) === 'script').length;
  return { outcome: { status: 'passed', findings: [], summary: `${plural(version.files.length, 'file')} (${plural(scripts, 'script')}) and ${plural(recorded.length, 'test data file')} match what was recorded`, detail, durationMs: Math.round(performance.now() - started) }, versionDir, fixtures: { directory: fixtureDir, files: fixtures.files } };
}
