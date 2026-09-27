// Artifact view types (FEAT-109) and the plain-English wording for a run whose
// declared, produced, and registered counts disagree. Discrepancies are shown,
// never corrected silently.

import type { Static } from '@sinclair/typebox';
import type { ArtifactDiscrepancySchema, ArtifactListResponseSchema, ArtifactPreviewSchema, ArtifactViewSchema, TablePageSchema } from '../contracts/artifact-api';

export type ArtifactView = Static<typeof ArtifactViewSchema>;
/** One entry of a run's list; identical to the detail view, because the list is capped. */
export type ArtifactListItem = ArtifactView;
export type ArtifactListResponse = Static<typeof ArtifactListResponseSchema>;
export type ArtifactPreview = Static<typeof ArtifactPreviewSchema>;
export type TablePage = Static<typeof TablePageSchema>;
export type ArtifactDiscrepancy = Static<typeof ArtifactDiscrepancySchema>;

/** The counts a run records about its outputs. */
export interface OutputCounts {
  readonly declaredOutputCount: number | null;
  /** Declared filenames with no file written, computed from the stored manifest against what registered or stayed behind. */
  readonly missingDeclaredCount: number;
  /** Registered artifacts nobody declared. */
  readonly undeclaredCount: number;
  readonly unregisteredOutputCount: number | null;
}

const files = (count: number) => `${count} file${count === 1 ? '' : 's'}`;

/**
 * Describe every difference between what a run declared, wrote, and kept.
 *
 * @param counts The run's recorded counts.
 * @returns One entry per kind of discrepancy, each with a sentence; empty when everything agrees.
 * @example describeDiscrepancies({ declaredOutputCount: 3, missingDeclaredCount: 2, undeclaredCount: 0, unregisteredOutputCount: 0 })[0].message
 */
export function describeDiscrepancies(counts: OutputCounts): ArtifactDiscrepancy[] {
  const result: ArtifactDiscrepancy[] = [];
  const { declaredOutputCount: declared, missingDeclaredCount: missing, undeclaredCount, unregisteredOutputCount: unregistered } = counts;
  if (missing > 0) result.push({ kind: 'missing', count: missing, message: `The script said it would produce ${files(Math.max(declared ?? 0, missing))}, but ${missing === 1 ? '1 of them was' : `${missing} of them were`} not written.` });
  if (undeclaredCount > 0) result.push({ kind: 'undeclared', count: undeclaredCount, message: `The script wrote ${files(undeclaredCount)} it did not list. ${undeclaredCount === 1 ? 'It is' : 'They are'} kept below and marked.` });
  if (unregistered !== null && unregistered > 0) result.push({ kind: 'unregistered', count: unregistered, message: `${files(unregistered)} the script wrote could not be kept, because of an unsupported file type or the per-run file limit.` });
  return result;
}
