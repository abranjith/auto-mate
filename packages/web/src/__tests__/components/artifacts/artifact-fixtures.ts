// Shared FEAT-109 web test data. A plain module, not a test file.
import type { ArtifactListResponse, ArtifactView, ScriptRun } from '@automate/core';

export const AT = '2026-09-25T00:00:00.000Z';
export const D = 'a'.repeat(64);

/** FEAT-107's corpus of untrusted text, carried to every artifact surface. */
export const HOSTILE = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', "=cmd|'/c calc'!A1"] as const;

export function artifact(overrides: Partial<ArtifactView> = {}): ArtifactView {
  const id = overrides.id ?? 1;
  return { id, executionId: 2, taskId: 3, scriptRunId: 4, filename: 'totals.csv', type: 'csv', extension: '.csv', mimeType: 'text/csv; charset=utf-8', renderMode: 'table', declared: true, title: 'Totals', description: 'Sales per region.', byteSize: 2048, sha256: D, contentScan: null, registeredAt: AT, contentUrl: `/api/artifacts/${id}/content`, downloadUrl: `/api/artifacts/${id}/download`, ...overrides };
}

export function list(artifacts: readonly ArtifactView[], overrides: Partial<ArtifactListResponse> = {}): ArtifactListResponse {
  return { executionId: 2, scriptRunId: 4, artifacts: [...artifacts], artifactCount: artifacts.length, unregisteredOutputCount: 0, declaredOutputCount: artifacts.length, producedOutputCount: artifacts.length, totalBytes: artifacts.reduce((sum, item) => sum + item.byteSize, 0), discrepancies: [], archiveUrl: artifacts.length ? '/api/executions/2/artifacts/archive' : null, ...overrides };
}

export function run(overrides: Partial<ScriptRun> = {}): ScriptRun {
  return { id: 1, executionId: 2, codeVersionId: 3, approvalId: 4, contentDigest: D, runtimeFingerprint: D, status: 'succeeded', exitCode: 0, stdout: '', stderr: '', outputTruncated: false, manifestPresent: true, declaredOutputs: [], declaredOutputCount: 1, producedOutputCount: 1, outputByteCount: 0, limitBreached: null, runtimeLockDigest: D, inputs: [], durationMs: 10, startedAt: AT, settledAt: AT, ...overrides };
}
