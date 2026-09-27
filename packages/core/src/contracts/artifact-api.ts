// ---------------------------------------------------------------------------
// Artifact API contracts (FEAT-109 TASK-001).
//
// Every artifact request parameter and response body is validated against
// these schemas. NO response carries a filesystem location: artifacts are
// named by `filename` (a model-authored display label) and fetched by id.
// ---------------------------------------------------------------------------

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ArtifactTypeSchema } from './generation-api';
import { RENDER_MODES } from '../artifacts/artifact-type';
import { MAX_TABLE_PAGE_ROWS } from '../artifacts/limits';

const Id = Type.Integer({ minimum: 1 });
const Count = Type.Integer({ minimum: 0 });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const RenderModeSchema = Type.Union(RENDER_MODES.map((mode) => Type.Literal(mode)));

/** `:id` in every artifact and execution path: a positive decimal integer with no sign, padding, or exponent. */
export const ArtifactIdParamsSchema = Type.Object({ id: Type.String({ pattern: '^[1-9][0-9]{0,14}$' }) });

/** `GET /api/artifacts/:id/rows` query, after numeric conversion. The server may lower `limit`'s ceiling by configuration, never raise it past this schema. */
export const TablePageQuerySchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TABLE_PAGE_ROWS })),
}, { additionalProperties: false });

/** The bounded formula-prefix scan: counts only, never a cell value. */
export const ContentScanSchema = Type.Object({
  scannedRows: Count,
  rowsAreCapped: Type.Boolean(),
  formulaCellCount: Count,
  sampledColumns: Count,
});

/** One registered artifact. `contentUrl`/`downloadUrl` are the only ways to its bytes. */
export const ArtifactViewSchema = Type.Object({
  id: Id,
  executionId: Id,
  taskId: Id,
  scriptRunId: Id,
  filename: Type.String(),
  type: ArtifactTypeSchema,
  extension: Type.String(),
  mimeType: Type.String(),
  renderMode: RenderModeSchema,
  declared: Type.Boolean(),
  title: Nullable(Type.String()),
  description: Nullable(Type.String()),
  byteSize: Count,
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  contentScan: Nullable(ContentScanSchema),
  registeredAt: Type.String(),
  contentUrl: Type.String(),
  downloadUrl: Type.String(),
});

export const ARTIFACT_DISCREPANCY_KINDS = ['undeclared', 'missing', 'unregistered'] as const;
/** A difference between what a run declared, produced, and registered, in words. */
export const ArtifactDiscrepancySchema = Type.Object({
  kind: Type.Union(ARTIFACT_DISCREPANCY_KINDS.map((kind) => Type.Literal(kind))),
  count: Type.Integer({ minimum: 1 }),
  message: Type.String(),
});

/**
 * `GET /api/executions/:id/artifacts`. Unpaginated on purpose — a documented
 * exception to the pagination rule, because `MAX_ARTIFACTS_PER_RUN` caps it.
 */
export const ArtifactListResponseSchema = Type.Object({
  executionId: Id,
  scriptRunId: Nullable(Id),
  artifacts: Type.Array(ArtifactViewSchema),
  artifactCount: Nullable(Count),
  unregisteredOutputCount: Nullable(Count),
  declaredOutputCount: Nullable(Count),
  producedOutputCount: Nullable(Count),
  totalBytes: Count,
  discrepancies: Type.Array(ArtifactDiscrepancySchema),
  archiveUrl: Nullable(Type.String()),
});

/** `GET /api/artifacts/:id/rows`: one page of a CSV or the first sheet of a workbook. Cells are text, verbatim, capped per cell. */
export const TablePageSchema = Type.Object({
  columns: Type.Array(Type.String()),
  rows: Type.Array(Type.Array(Type.String())),
  offset: Count,
  limit: Type.Integer({ minimum: 1 }),
  hasMore: Type.Boolean(),
  scannedRowsCapped: Type.Boolean(),
  truncatedCellCount: Count,
  sheet: Nullable(Type.String()),
  otherSheets: Type.Array(Type.String()),
  formulaCellCount: Nullable(Count),
});

/** `GET /api/artifacts/:id/preview`: the head of a text, JSON, or Markdown artifact. */
export const ArtifactPreviewSchema = Type.Object({
  text: Type.String(),
  truncated: Type.Boolean(),
  byteSize: Count,
  previewBytes: Count,
});

export type ArtifactIdParams = Static<typeof ArtifactIdParamsSchema>;
export type TablePageQuery = Static<typeof TablePageQuerySchema>;
export type ContentScan = Static<typeof ContentScanSchema>;
export type ArtifactDiscrepancyKind = (typeof ARTIFACT_DISCREPANCY_KINDS)[number];
