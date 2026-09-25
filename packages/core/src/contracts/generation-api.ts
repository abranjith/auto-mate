// ---------------------------------------------------------------------------
// Code-generation contracts (FEAT-106 TASK-001).
//
// Two kinds of schema live here: REST shapes the browser reads, and the four
// agent tools' parameter schemas. Both cross a boundary as JSON, so every
// field survives a JSON round trip: no `Date`, no `undefined`, no `NaN`.
//
// Path rule: no schema here has a field capable of holding an absolute path.
// A generated file's `path` is relative to its attempt directory and a
// fixture is named by its stored filename only.
// ---------------------------------------------------------------------------

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { CODE_FILE_ROLES, CODE_VERSION_STATUSES } from '../generation/code-version';
import { MAX_CODE_PATH_CHARS, MAX_GUIDANCE_CHARS } from '../generation/limits';
import { FileFormatSchema, InferredTypeSchema } from './upload-api';

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Id = Type.Integer({ minimum: 1 });
const Count = Type.Integer({ minimum: 0 });
const Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const Closed = { additionalProperties: false } as const;

/** Output types a generated script may declare in `manifest.json` (memory's artifact model). */
export const ARTIFACT_TYPES = ['csv', 'plotly-html', 'html', 'image', 'markdown', 'json', 'text', 'xlsx', 'pdf'] as const;
export const ArtifactTypeSchema = Type.Union(ARTIFACT_TYPES.map((type) => Type.Literal(type)));

/** Every `generation_attempt.status`. `errored` is pytest failing to start; `failed` is tests that ran and did not pass. */
export const ATTEMPT_STATUSES = ['running', 'passed', 'failed', 'errored', 'timed_out', 'aborted', 'refused'] as const;
/** Why the application refused a `run_tests` call. A refusal is a recorded outcome, never an error. */
export const REFUSAL_REASONS = ['attempt_limit', 'time_limit', 'cost_limit', 'diagnostics_not_granted', 'runtime_unavailable'] as const;
/** How a generation phase ended, as recorded in the `generation_settled` event. */
export const GENERATION_OUTCOMES = ['finalized', 'exhausted', 'timed_out', 'cost_limit', 'aborted', 'incomplete'] as const;

export const CodeVersionStatusSchema = Type.Union(CODE_VERSION_STATUSES.map((status) => Type.Literal(status)));
export const CodeFileRoleSchema = Type.Union(CODE_FILE_ROLES.map((role) => Type.Literal(role)));
export const AttemptStatusSchema = Type.Union(ATTEMPT_STATUSES.map((status) => Type.Literal(status)));
export const RefusalReasonSchema = Type.Union(REFUSAL_REASONS.map((reason) => Type.Literal(reason)));
export const GenerationOutcomeSchema = Type.Union(GENERATION_OUTCOMES.map((outcome) => Type.Literal(outcome)));

/** One input the finalized script says it needs: which file, which sheet, and which columns. */
export const DeclaredInputSchema = Type.Object({
  fileRole: Type.String({ minLength: 1, maxLength: 255, description: 'The input filename the script reads, exactly as the code contract names it.' }),
  sheet: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  requiredColumns: Type.Array(Type.Object({ name: Type.String({ minLength: 1 }), type: InferredTypeSchema }, Closed), { maxItems: 512 }),
}, Closed);
/** One output the finalized script says it writes, in memory's manifest shape. */
export const DeclaredOutputSchema = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: 255 }),
  type: ArtifactTypeSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
}, Closed);

/** One file of one version. `content` is present only on the detail route. */
export const CodeFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: MAX_CODE_PATH_CHARS }),
  role: CodeFileRoleSchema,
  byteSize: Count,
  lineCount: Count,
  sha256: Digest,
  content: Type.Optional(Type.String()),
});
/** `GET /api/executions/:id/code-versions` item: never any file content. */
export const CodeVersionSummarySchema = Type.Object({
  id: Id,
  executionId: Id,
  attempt: Type.Integer({ minimum: 1 }),
  status: CodeVersionStatusSchema,
  contentDigest: Nullable(Digest),
  entrypoint: Type.String(),
  isFinal: Type.Boolean(),
  testsPassed: Nullable(Type.Boolean()),
  summary: Nullable(Type.String()),
  sealedAt: Nullable(Type.String()),
  createdAt: Type.String(),
  files: Type.Array(CodeFileSchema),
});
/** `GET /api/code-versions/:id`: the version, its declared contracts, and every file's content. */
export const CodeVersionDetailSchema = Type.Composite([
  CodeVersionSummarySchema,
  Type.Object({ declaredInputs: Nullable(Type.Array(DeclaredInputSchema)), declaredOutputs: Nullable(Type.Array(DeclaredOutputSchema)) }),
]);
/** One `run_tests` invocation. `diagnostics` is the filtered text that was sent, joined from its transmission receipt. */
export const GenerationAttemptSchema = Type.Object({
  id: Id,
  executionId: Id,
  codeVersionId: Nullable(Id),
  attempt: Type.Integer({ minimum: 1 }),
  status: AttemptStatusSchema,
  refusalReason: Nullable(RefusalReasonSchema),
  testsTotal: Nullable(Count),
  testsPassed: Nullable(Count),
  testsFailed: Nullable(Count),
  exitCode: Nullable(Type.Integer()),
  manifestPresent: Nullable(Type.Boolean()),
  diagnosticDigest: Nullable(Digest),
  droppedLineCount: Nullable(Count),
  durationMs: Nullable(Count),
  startedAt: Type.String(),
  settledAt: Nullable(Type.String()),
  diagnostics: Nullable(Type.String()),
});
/** One sheet of a fixture preview: the person's own approved data returning to their own browser. */
export const FixturePreviewTableSchema = Type.Object({ sheetName: Nullable(Type.String()), header: Type.Array(Type.String()), rows: Type.Array(Type.Array(Type.String())) });
/** The synthetic stand-in one execution tested against, with a bounded preview. */
export const SyntheticFixtureSchema = Type.Object({
  id: Id,
  executionId: Id,
  uploadId: Id,
  fileName: Type.String(),
  format: FileFormatSchema,
  sheetCount: Type.Integer({ minimum: 1 }),
  rowCount: Count,
  sampleRowCount: Count,
  byteSize: Count,
  sha256: Digest,
  seed: Type.String(),
  createdAt: Type.String(),
  preview: Type.Array(FixturePreviewTableSchema),
});
/** `POST /api/executions/:id/retry`. */
export const RetryRequestSchema = Type.Object({ guidance: Type.Optional(Type.String({ maxLength: MAX_GUIDANCE_CHARS })) }, Closed);

/** `write_script` parameters. The content is stored and versioned, never written to a shared directory. */
export const WriteScriptArgsSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: MAX_CODE_PATH_CHARS, description: 'Relative .py path such as `main.py` or `lib/helpers.py`; forward slashes, at most two levels, no `..`.' }),
  content: Type.String({ minLength: 1, description: 'The complete file text. Writing the same path again replaces it within this attempt.' }),
}, Closed);
/** `write_test` parameters. The file name must be `test_<name>.py` or `<name>_test.py`. */
export const WriteTestArgsSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: MAX_CODE_PATH_CHARS, description: 'Relative pytest file path such as `test_main.py`.' }),
  content: Type.String({ minLength: 1, description: 'The complete pytest file text.' }),
}, Closed);
/** `run_tests` takes no parameters: the application decides what runs, where, and against which data. */
export const RunTestsArgsSchema = Type.Object({}, Closed);
/** `finalize_script` parameters: the version's entrypoint, plain-English summary, and declared input/output contracts. */
export const FinalizeScriptArgsSchema = Type.Object({
  entrypoint: Type.String({ minLength: 1, maxLength: MAX_CODE_PATH_CHARS, description: 'The script file to run, for example `main.py`.' }),
  summary: Type.String({ minLength: 1, maxLength: 4000, description: 'What the script does, in plain English for a non-programmer.' }),
  declaredInputs: Type.Array(DeclaredInputSchema, { maxItems: 20 }),
  declaredOutputs: Type.Array(DeclaredOutputSchema, { maxItems: 50 }),
}, Closed);

export const CodeVersionListResponseSchema = Type.Object({ codeVersions: Type.Array(CodeVersionSummarySchema) });
/** The attempts plus the limits they run under, so a progress line can say "Attempt 2 of 3" before the first test run. */
export const GenerationLimitsSchema = Type.Object({ maxAttempts: Type.Integer({ minimum: 1 }), timeoutMs: Type.Integer({ minimum: 1 }) });
export const GenerationAttemptListResponseSchema = Type.Object({ attempts: Type.Array(GenerationAttemptSchema), limits: GenerationLimitsSchema });
export const SyntheticFixtureListResponseSchema = Type.Object({ fixtures: Type.Array(SyntheticFixtureSchema) });

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type RefusalReason = (typeof REFUSAL_REASONS)[number];
export type GenerationOutcome = (typeof GENERATION_OUTCOMES)[number];
export type DeclaredInput = Static<typeof DeclaredInputSchema>;
export type DeclaredOutput = Static<typeof DeclaredOutputSchema>;
export type CodeFile = Static<typeof CodeFileSchema>;
export type CodeVersionSummary = Static<typeof CodeVersionSummarySchema>;
export type CodeVersionDetail = Static<typeof CodeVersionDetailSchema>;
export type GenerationAttempt = Static<typeof GenerationAttemptSchema>;
export type FixturePreviewTable = Static<typeof FixturePreviewTableSchema>;
export type SyntheticFixture = Static<typeof SyntheticFixtureSchema>;
export type RetryRequest = Static<typeof RetryRequestSchema>;
export type WriteScriptArgs = Static<typeof WriteScriptArgsSchema>;
export type WriteTestArgs = Static<typeof WriteTestArgsSchema>;
export type FinalizeScriptArgs = Static<typeof FinalizeScriptArgsSchema>;
export type CodeVersionListResponse = Static<typeof CodeVersionListResponseSchema>;
export type GenerationAttemptListResponse = Static<typeof GenerationAttemptListResponseSchema>;
export type GenerationLimits = Static<typeof GenerationLimitsSchema>;
export type SyntheticFixtureListResponse = Static<typeof SyntheticFixtureListResponseSchema>;
/** The view types named by the generation module; aliases so there is one definition of each shape. */
export type CodeFileView = CodeFile;
export type CodeVersionView = CodeVersionDetail;
export type GenerationAttemptView = GenerationAttempt;
