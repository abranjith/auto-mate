import { findWallClockReads, shortDigest, type InputContract, type RuntimeDetail } from '@automate/core';
import type { TemplateRevisionRow, TemplateRow, TemplateRevisionFileRow } from '../db/repositories/template-repository';

export function presentTemplate(row: TemplateRow) {
  return { id: row.id, name: row.name, description: row.description, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export function presentRevisionSummary(row: TemplateRevisionRow) {
  return { id: row.id, number: row.revisionNumber, createdAt: row.createdAt.toISOString(), sourceExecutionId: row.sourceExecutionId, note: row.note };
}

export function presentRevision(row: TemplateRevisionRow, files: TemplateRevisionFileRow[] = []) {
  const contract = JSON.parse(row.inputContract) as InputContract;
  const runtime = JSON.parse(row.runtimeDetail) as RuntimeDetail;
  const runtimeLine = `Python ${runtime.pythonVersion ?? '?'} on ${runtime.platform ?? '?'} · ${runtime.packages?.length ?? 0} packages`;
  return { id: row.id, number: row.revisionNumber, createdAt: row.createdAt.toISOString(), contentDigestShort: shortDigest(row.contentDigest), summary: row.summary, declaredOutputs: JSON.parse(row.declaredOutputs) as unknown, inputs: contract.inputs, rules: contract.rules, notes: contract.notes, runtimeLine, readsWallClock: row.readsWallClock ? findWallClockReads(files) : [], note: row.note };
}

export function presentRevisionFile(row: TemplateRevisionFileRow) {
  return { path: row.path, role: row.role, byteSize: row.byteSize, lineCount: row.content.split('\n').length, sha256: row.sha256, content: row.content };
}
