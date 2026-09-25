// Turn FEAT-107 rows into API shapes. No absolute path leaves here: findings
// carry version-relative paths, runs carry output filenames only.

import { describeRuntime, type CheckKey, type CheckStatus, type FindingConfidence, type FindingSeverity, type RuntimeDetail, type VerificationCheckView, type VerificationFindingView, type VerificationReport, type VerificationStatus } from '@automate/core';
import type { VerificationRunWithChecks } from '../db/repositories/verification-repository';

const parseDetail = (text: string | null): unknown => {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
};

/** A pass's checks as the core views `summarizeVerification` reads. */
export function checkViews(run: VerificationRunWithChecks): VerificationCheckView[] {
  return run.checks.map((check) => ({ checkKey: check.checkKey as CheckKey, status: check.status as CheckStatus, isBlocking: check.isBlocking, summary: check.summary, detail: parseDetail(check.detail), durationMs: check.durationMs }));
}

/** A pass's findings as the core views. */
export function findingViews(run: VerificationRunWithChecks): VerificationFindingView[] {
  return run.findings.map((finding) => ({ checkKey: finding.checkKey, ruleCode: finding.ruleCode, severity: finding.severity as FindingSeverity, confidence: finding.confidence as FindingConfidence | null, filePath: finding.filePath, line: finding.line, column: finding.column, message: finding.message, isBlocking: finding.isBlocking }));
}

/** `GET /api/executions/:id/verification`. Checks come in `CHECK_KEYS` order from the repository. */
export function presentVerification(run: VerificationRunWithChecks): VerificationReport {
  const runtime = JSON.parse(run.runtimeDetail) as RuntimeDetail;
  return {
    id: run.id,
    executionId: run.executionId,
    codeVersionId: run.codeVersionId,
    contentDigest: run.contentDigest,
    runtimeFingerprint: run.runtimeFingerprint,
    runtime: { ...runtime, packages: [...runtime.packages] },
    runtimeDescription: describeRuntime(runtime),
    status: run.status as VerificationStatus,
    blockingCount: run.blockingCount,
    advisoryCount: run.advisoryCount,
    summary: run.summary,
    durationMs: run.durationMs,
    startedAt: run.startedAt.toISOString(),
    settledAt: run.settledAt?.toISOString() ?? null,
    checks: checkViews(run),
    findings: run.findings.map((finding) => ({ id: finding.id, ...findingViews({ ...run, findings: [finding] })[0]! })),
  };
}
