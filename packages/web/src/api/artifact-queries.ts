import { Value } from '@sinclair/typebox/value';
import { ArtifactListResponseSchema, ArtifactPreviewSchema, ArtifactViewSchema, TablePageSchema, type ArtifactListResponse, type ArtifactPreview, type ArtifactView, type TablePage } from '@automate/core';
import { getJson } from './api-client';

/** A run's artifacts, counts, and discrepancies (FEAT-109). */
export function getArtifacts(executionId: number): Promise<ArtifactListResponse> {
  return getJson(`/executions/${executionId}/artifacts`, (value): value is ArtifactListResponse => Value.Check(ArtifactListResponseSchema, value));
}
/** One artifact's view. */
export function getArtifact(id: number): Promise<ArtifactView> {
  return getJson(`/artifacts/${id}`, (value): value is ArtifactView => Value.Check(ArtifactViewSchema, value));
}
/** One page of a CSV or workbook artifact, read on the server. */
export function getTablePage(id: number, offset: number, limit: number): Promise<TablePage> {
  return getJson(`/artifacts/${id}/rows?offset=${offset}&limit=${limit}`, (value): value is TablePage => Value.Check(TablePageSchema, value));
}
/** The head of a text, JSON, or Markdown artifact. */
export function getPreview(id: number): Promise<ArtifactPreview> {
  return getJson(`/artifacts/${id}/preview`, (value): value is ArtifactPreview => Value.Check(ArtifactPreviewSchema, value));
}
/** The inline bytes URL, for the sandboxed frame and `<img>`. */
export const artifactContentUrl = (id: number) => `/api/artifacts/${id}/content`;
/** The attachment URL. */
export const artifactDownloadUrl = (id: number) => `/api/artifacts/${id}/download`;
/** The whole run as one store-only ZIP. */
export const artifactArchiveUrl = (executionId: number) => `/api/executions/${executionId}/artifacts/archive`;
