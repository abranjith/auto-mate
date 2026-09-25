import {
  countLines,
  type AttemptStatus,
  type CodeFile,
  type CodeFileRole,
  type CodeVersionDetail,
  type CodeVersionStatus,
  type CodeVersionSummary,
  type DeclaredInput,
  type DeclaredOutput,
  type GenerationAttempt,
  type RefusalReason,
} from '@automate/core';
import type { CodeFileRow, CodeVersionRow } from '../db/repositories/code-version-repository';
import type { GenerationAttemptRow } from '../db/repositories/generation-attempt-repository';

/** Project one file row; content only when asked for. */
export function presentCodeFile(row: CodeFileRow, withContent: boolean): CodeFile {
  return { path: row.path, role: row.role as CodeFileRole, byteSize: row.byteSize, lineCount: countLines(row.content), sha256: row.sha256, ...(withContent ? { content: row.content } : {}) };
}

/** Project a version without any file content, for lists and transcripts. */
export function presentCodeVersionSummary(version: CodeVersionRow, files: readonly CodeFileRow[]): CodeVersionSummary {
  return {
    id: version.id,
    executionId: version.executionId,
    attempt: version.attempt,
    status: version.status as CodeVersionStatus,
    contentDigest: version.contentDigest,
    entrypoint: version.entrypoint,
    isFinal: version.isFinal,
    testsPassed: version.testsPassed,
    summary: version.summary,
    sealedAt: version.sealedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    files: files.map((file) => presentCodeFile(file, false)),
  };
}

/** Project a version with every file's content and its declared contracts. */
export function presentCodeVersionDetail(version: CodeVersionRow, files: readonly CodeFileRow[]): CodeVersionDetail {
  return {
    ...presentCodeVersionSummary(version, files),
    files: files.map((file) => presentCodeFile(file, true)),
    declaredInputs: version.declaredInputs === null ? null : (JSON.parse(version.declaredInputs) as DeclaredInput[]),
    declaredOutputs: version.declaredOutputs === null ? null : (JSON.parse(version.declaredOutputs) as DeclaredOutput[]),
  };
}

/** Project an attempt, joined to the filtered diagnostic text that was sent for it (or null). */
export function presentAttempt(row: GenerationAttemptRow, diagnostics: string | null): GenerationAttempt {
  return {
    id: row.id,
    executionId: row.executionId,
    codeVersionId: row.codeVersionId,
    attempt: row.attempt,
    status: row.status as AttemptStatus,
    refusalReason: row.refusalReason as RefusalReason | null,
    testsTotal: row.testsTotal,
    testsPassed: row.testsPassed,
    testsFailed: row.testsFailed,
    exitCode: row.exitCode,
    manifestPresent: row.manifestPresent,
    diagnosticDigest: row.diagnosticDigest,
    droppedLineCount: row.droppedLineCount,
    durationMs: row.durationMs,
    startedAt: row.startedAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    diagnostics,
  };
}
