// ---------------------------------------------------------------------------
// Verification, approval, run, and review contracts (FEAT-107 TASK-001).
//
// Every shape crosses a socket or an HTTP body, so every field survives a JSON
// round trip. Path rule: no field here can hold an absolute path — findings
// carry version-relative paths, runs carry output filenames, inputs carry the
// person's original filename as a label only.
//
// Untrusted text rendered from these shapes: finding messages (tool output
// about model-written code), the agent's summary, declared/manifest titles and
// descriptions, and a run's captured output (may contain the person's cells).
// ---------------------------------------------------------------------------

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ArtifactTypeSchema } from './generation-api';
import { CHECK_KEYS, CHECK_STATUSES, FINDING_CONFIDENCES, FINDING_SEVERITIES, VERIFICATION_STATUSES } from '../verification/verification';
import { REVIEW_VERDICTS } from '../verification/review';
import { MAX_REVIEW_FEEDBACK_CHARS } from '../verification/limits';

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const Id = Type.Integer({ minimum: 1 });
const Count = Type.Integer({ minimum: 0 });
const Digest = Type.String({ pattern: '^[0-9a-f]{64}$' });
const Closed = { additionalProperties: false } as const;

export const CheckKeySchema = literals(CHECK_KEYS);
export const CheckStatusSchema = literals(CHECK_STATUSES);
export const FindingSeveritySchema = literals(FINDING_SEVERITIES);
export const FindingConfidenceSchema = literals(FINDING_CONFIDENCES);
export const VerificationStatusSchema = literals(VERIFICATION_STATUSES);
export const SCRIPT_RUN_STATUSES = ['running', 'succeeded', 'failed', 'errored', 'timed_out', 'aborted'] as const;
export const ScriptRunStatusSchema = literals(SCRIPT_RUN_STATUSES);
export const APPROVAL_DECISIONS = ['approved', 'cancelled'] as const;
export const ApprovalDecisionSchema = literals(APPROVAL_DECISIONS);

export const RuntimePackageSchema = Type.Object({ name: Type.String(), version: Type.String() });
export const RuntimeDetailSchema = Type.Object({ pythonVersion: Type.String(), uvVersion: Type.String(), platform: Type.String(), arch: Type.String(), packages: Type.Array(RuntimePackageSchema) });

export const VerificationFindingSchema = Type.Object({
  id: Id,
  checkKey: CheckKeySchema,
  ruleCode: Type.String(),
  severity: FindingSeveritySchema,
  confidence: Nullable(FindingConfidenceSchema),
  filePath: Nullable(Type.String()),
  line: Nullable(Type.Integer()),
  column: Nullable(Type.Integer()),
  message: Type.String(),
  isBlocking: Type.Boolean(),
});
export const VerificationCheckSchema = Type.Object({
  checkKey: CheckKeySchema,
  status: CheckStatusSchema,
  isBlocking: Type.Boolean(),
  summary: Type.String(),
  detail: Type.Unknown(),
  durationMs: Nullable(Count),
});
/** `GET /api/executions/:id/verification`: the latest pass, checks in `CHECK_KEYS` order, and its findings. */
export const VerificationReportSchema = Type.Object({
  id: Id,
  executionId: Id,
  codeVersionId: Id,
  contentDigest: Digest,
  runtimeFingerprint: Digest,
  runtime: RuntimeDetailSchema,
  runtimeDescription: Type.String(),
  status: VerificationStatusSchema,
  blockingCount: Count,
  advisoryCount: Count,
  summary: Nullable(Type.String()),
  durationMs: Nullable(Count),
  startedAt: Type.String(),
  settledAt: Nullable(Type.String()),
  checks: Type.Array(VerificationCheckSchema),
  findings: Type.Array(VerificationFindingSchema),
});

const RunIntentCheckSchema = Type.Object({ checkKey: CheckKeySchema, status: CheckStatusSchema, isBlocking: Type.Boolean(), summary: Type.String() });
/** The object the gate renders; its canonical digest is what an approval binds to. */
export const RunIntentSchema = Type.Object({
  executionId: Id,
  codeVersion: Type.Object({ id: Id, shortDigest: Type.String(), contentDigest: Digest, fileCount: Count, lineCount: Count, entrypoint: Type.String() }),
  verificationRunId: Id,
  summary: Nullable(Type.String()),
  inputs: Type.Array(Type.Object({ uploadId: Id, originalFilename: Type.String(), byteSize: Count, shortSha256: Type.String(), sheets: Type.Array(Type.String()) })),
  outputs: Type.Array(Type.Object({ filename: Type.String(), type: ArtifactTypeSchema, title: Type.String(), description: Type.String() })),
  checks: Type.Array(RunIntentCheckSchema),
  verdict: Type.String(),
  blockingCount: Count,
  advisoryCount: Count,
  tests: Type.Object({ total: Nullable(Count), passed: Nullable(Count), fixtureRowCount: Nullable(Count) }),
  runtime: Type.Object({ fingerprint: Digest, description: Type.String(), packages: Type.Array(RuntimePackageSchema) }),
  caveats: Type.Array(Type.String()),
});
/** `GET /api/executions/:id/intent`. */
export const RunIntentResponseSchema = Type.Object({ intent: RunIntentSchema, intentDigest: Digest });

/** `POST /api/executions/:id/approval`. */
export const ApprovalRequestSchema = Type.Object({ intentDigest: Digest, decision: ApprovalDecisionSchema, acknowledgedWarnings: Type.Boolean() }, Closed);
/** The outcome of a decision: recorded, or sent back to re-verification with the concrete changes. */
export const ApprovalResponseSchema = Type.Object({
  outcome: Type.Union([Type.Literal('approved'), Type.Literal('cancelled'), Type.Literal('reverify')]),
  approvalId: Nullable(Id),
  runtimeChanges: Type.Array(Type.String()),
  status: Type.String(),
});

/** `GET /api/executions/:id/run`: never a location, only filenames. */
export const ScriptRunSchema = Type.Object({
  id: Id,
  executionId: Id,
  codeVersionId: Id,
  approvalId: Id,
  contentDigest: Digest,
  runtimeFingerprint: Digest,
  status: ScriptRunStatusSchema,
  exitCode: Nullable(Type.Integer()),
  stdout: Nullable(Type.String()),
  stderr: Nullable(Type.String()),
  outputTruncated: Type.Boolean(),
  manifestPresent: Nullable(Type.Boolean()),
  declaredOutputs: Type.Array(Type.Object({ filename: Type.String(), type: ArtifactTypeSchema, title: Type.String(), description: Type.String(), byteSize: Nullable(Count), present: Type.Boolean() })),
  declaredOutputCount: Nullable(Count),
  producedOutputCount: Nullable(Count),
  outputByteCount: Nullable(Count),
  limitBreached: Nullable(Type.Union([Type.Literal('time'), Type.Literal('memory'), Type.Literal('output_bytes'), Type.Literal('output_files')])),
  runtimeLockDigest: Nullable(Digest),
  inputs: Type.Array(Type.Object({ uploadId: Id, byteSize: Count, shortSha256: Type.String() })),
  durationMs: Nullable(Count),
  startedAt: Type.String(),
  settledAt: Nullable(Type.String()),
});

/** `POST /api/executions/:id/review`. Feedback is required, and non-blank, for a rejection. */
export const ReviewRequestSchema = Type.Object({ verdict: literals(REVIEW_VERDICTS), feedback: Type.Optional(Type.String({ maxLength: MAX_REVIEW_FEEDBACK_CHARS })) }, Closed);
export const ReviewResponseSchema = Type.Object({ status: Type.String(), retryExecutionId: Nullable(Id) });

export type RuntimeDetailPayload = Static<typeof RuntimeDetailSchema>;
export type VerificationFinding = Static<typeof VerificationFindingSchema>;
export type VerificationCheck = Static<typeof VerificationCheckSchema>;
export type VerificationReport = Static<typeof VerificationReportSchema>;
export type RunIntentResponse = Static<typeof RunIntentResponseSchema>;
export type ApprovalRequest = Static<typeof ApprovalRequestSchema>;
export type ApprovalResponse = Static<typeof ApprovalResponseSchema>;
export type ScriptRunStatus = (typeof SCRIPT_RUN_STATUSES)[number];
export type ScriptRun = Static<typeof ScriptRunSchema>;
export type ReviewRequest = Static<typeof ReviewRequestSchema>;
export type ReviewResponse = Static<typeof ReviewResponseSchema>;
