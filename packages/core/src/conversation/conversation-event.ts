// Browser-safe conversation contract. It may wrap AgentEvent, but must never
// import a provider SDK type. Every field must survive JSON round-tripping.
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { AgentEvent } from '../agent/provider-types';
import { EXECUTION_STATUSES, type ExecutionStatus } from './execution-state';
import { ATTEMPT_STATUSES, CodeFileRoleSchema, GENERATION_OUTCOMES, REFUSAL_REASONS, type AttemptStatus, type GenerationOutcome, type RefusalReason } from '../contracts/generation-api';
import type { CodeFileRole } from '../generation/code-version';
import { VERIFICATION_STATUSES, type VerificationStatus } from '../verification/verification';
import { REVIEW_VERDICTS, type ReviewVerdict } from '../verification/review';

/** A real run's settled status (FEAT-107); mirrors `script_run.status`. */
export const RUN_EVENT_STATUSES = ['succeeded', 'failed', 'errored', 'timed_out', 'aborted'] as const;
export type RunEventStatus = (typeof RUN_EVENT_STATUSES)[number];

const At = Type.String();
const UnknownJson = Type.Unknown();
const NullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const AgentUsageSchema = Type.Object({
  turns: Type.Integer({ minimum: 0 }),
  inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
});
const variants: TSchema[] = [
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('tool_started'),
    callId: Type.String(),
    tool: Type.String(),
    input: UnknownJson,
    at: At,
  }),
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('tool_finished'),
    callId: Type.String(),
    tool: Type.String(),
    output: UnknownJson,
    isError: Type.Boolean(),
    at: At,
  }),
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('assistant_text'),
    text: Type.String(),
    at: At,
  }),
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('turn_finished'),
    usage: AgentUsageSchema,
    at: At,
  }),
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('failed'),
    error: Type.Object({ code: Type.String(), message: Type.String() }),
    at: At,
  }),
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('user_prompt'),
    text: Type.String(),
    at: At,
  }),
  Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    type: Type.Literal('state_changed'),
    from: Type.Union(EXECUTION_STATUSES.map((status) => Type.Literal(status))),
    to: Type.Union(EXECUTION_STATUSES.map((status) => Type.Literal(status))),
    at: At,
  }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('clarification_requested'), clarificationId: Type.Integer({ minimum: 1 }), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('clarification_answered'), clarificationId: Type.Integer({ minimum: 1 }), at: At }),
  // FEAT-106: application-owned generation receipts. None carries code or diagnostic text; both are fetched over REST on demand.
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('code_version_sealed'), codeVersionId: Type.Integer({ minimum: 1 }), attempt: Type.Integer({ minimum: 1 }), digest: Type.String({ pattern: '^[0-9a-f]{64}$' }), files: Type.Array(Type.Object({ path: Type.String(), role: CodeFileRoleSchema, byteSize: Type.Integer({ minimum: 0 }), lineCount: Type.Integer({ minimum: 0 }) })), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('test_run_finished'), attemptId: Type.Integer({ minimum: 1 }), attempt: Type.Integer({ minimum: 1 }), outcome: Type.Union(ATTEMPT_STATUSES.map((status) => Type.Literal(status))), refusalReason: Type.Union([...REFUSAL_REASONS.map((reason) => Type.Literal(reason)), Type.Null()]), testsTotal: NullableCount, testsPassed: NullableCount, testsFailed: NullableCount, droppedLineCount: NullableCount, attemptsRemaining: Type.Integer({ minimum: 0 }), attemptLimit: Type.Integer({ minimum: 1 }), manifestPresent: Type.Union([Type.Boolean(), Type.Null()]), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('generation_settled'), outcome: Type.Union(GENERATION_OUTCOMES.map((outcome) => Type.Literal(outcome))), codeVersionId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), digest: Type.Union([Type.String(), Type.Null()]), attemptsUsed: Type.Integer({ minimum: 0 }), attemptLimit: Type.Integer({ minimum: 1 }), summary: Type.String(), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('disclosure_sent'), transmissionId: Type.Integer({ minimum: 1 }), kind: Type.Union([Type.Literal('context'), Type.Literal('diagnostics')]), provider: Type.String(), model: Type.String(), byteSize: Type.Integer({ minimum: 0 }), summary: UnknownJson, at: At }),
  // FEAT-107: application-owned gate receipts. None carries a finding message, run output, feedback text, or a path; those are fetched over REST.
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('verification_finished'), verificationRunId: Type.Integer({ minimum: 1 }), codeVersionId: Type.Integer({ minimum: 1 }), status: Type.Union(VERIFICATION_STATUSES.map((status) => Type.Literal(status))), blockingCount: Type.Integer({ minimum: 0 }), advisoryCount: Type.Integer({ minimum: 0 }), summary: Type.String(), runtimeDescription: Type.String(), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('approval_decided'), approvalId: Type.Integer({ minimum: 1 }), decision: Type.Union([Type.Literal('approved'), Type.Literal('cancelled')]), acknowledgedWarnings: Type.Boolean(), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('run_finished'), scriptRunId: Type.Integer({ minimum: 1 }), status: Type.Union(RUN_EVENT_STATUSES.map((status) => Type.Literal(status))), exitCode: Type.Union([Type.Integer(), Type.Null()]), durationMs: Type.Integer({ minimum: 0 }), declaredOutputCount: NullableCount, producedOutputCount: NullableCount, outputTruncated: Type.Boolean(), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('review_decided'), verdict: Type.Union(REVIEW_VERDICTS.map((verdict) => Type.Literal(verdict))), retryExecutionId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('runtime_prepared'), kind: Type.Union([Type.Literal('script'), Type.Literal('verify')]), pythonVersion: Type.String(), packageCount: Type.Integer({ minimum: 0 }), at: At }),
  // FEAT-109: counts only. No filename, title, path, or cell value; the artifact list is fetched over REST.
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('artifacts_registered'), scriptRunId: Type.Integer({ minimum: 1 }), artifactCount: Type.Integer({ minimum: 0 }), undeclaredCount: Type.Integer({ minimum: 0 }), unregisteredOutputCount: Type.Integer({ minimum: 0 }), totalBytes: Type.Integer({ minimum: 0 }), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('task_saved'), templateId: Type.Integer({ minimum: 1 }), name: Type.String(), revisionNumber: Type.Integer({ minimum: 1 }), at: At }),
  Type.Object({ seq: Type.Integer({ minimum: 1 }), type: Type.Literal('reuse_started'), templateName: Type.String(), revisionNumber: Type.Integer({ minimum: 1 }), digestShort: Type.String(), asOfDate: Type.String(), timeZone: Type.String(), compatibilityStatus: Type.String(), advisoryHeadlines: Type.Array(Type.String()), runtimeChanged: Type.Boolean(), asOfNotRecorded: Type.Optional(Type.Boolean()), at: At }),
];

export const ConversationEventSchema = Type.Union(variants);
export type ConversationEvent = { readonly seq: number } & (
  | AgentEvent
  | { readonly type: 'user_prompt'; readonly text: string; readonly at: string }
  | {
      readonly type: 'state_changed';
      readonly from: ExecutionStatus;
      readonly to: ExecutionStatus;
      readonly at: string;
    }
  | { readonly type: 'clarification_requested'; readonly clarificationId: number; readonly at: string }
  | { readonly type: 'clarification_answered'; readonly clarificationId: number; readonly at: string }
  | { readonly type: 'code_version_sealed'; readonly codeVersionId: number; readonly attempt: number; readonly digest: string; readonly files: readonly { readonly path: string; readonly role: CodeFileRole; readonly byteSize: number; readonly lineCount: number }[]; readonly at: string }
  | { readonly type: 'test_run_finished'; readonly attemptId: number; readonly attempt: number; readonly outcome: AttemptStatus; readonly refusalReason: RefusalReason | null; readonly testsTotal: number | null; readonly testsPassed: number | null; readonly testsFailed: number | null; readonly droppedLineCount: number | null; readonly attemptsRemaining: number; readonly attemptLimit: number; readonly manifestPresent: boolean | null; readonly at: string }
  | { readonly type: 'generation_settled'; readonly outcome: GenerationOutcome; readonly codeVersionId: number | null; readonly digest: string | null; readonly attemptsUsed: number; readonly attemptLimit: number; readonly summary: string; readonly at: string }
  | { readonly type: 'verification_finished'; readonly verificationRunId: number; readonly codeVersionId: number; readonly status: VerificationStatus; readonly blockingCount: number; readonly advisoryCount: number; readonly summary: string; readonly runtimeDescription: string; readonly at: string }
  | { readonly type: 'approval_decided'; readonly approvalId: number; readonly decision: 'approved' | 'cancelled'; readonly acknowledgedWarnings: boolean; readonly at: string }
  | { readonly type: 'run_finished'; readonly scriptRunId: number; readonly status: RunEventStatus; readonly exitCode: number | null; readonly durationMs: number; readonly declaredOutputCount: number | null; readonly producedOutputCount: number | null; readonly outputTruncated: boolean; readonly at: string }
  | { readonly type: 'review_decided'; readonly verdict: ReviewVerdict; readonly retryExecutionId: number | null; readonly at: string }
  | { readonly type: 'runtime_prepared'; readonly kind: 'script' | 'verify'; readonly pythonVersion: string; readonly packageCount: number; readonly at: string }
  | { readonly type: 'artifacts_registered'; readonly scriptRunId: number; readonly artifactCount: number; readonly undeclaredCount: number; readonly unregisteredOutputCount: number; readonly totalBytes: number; readonly at: string }
  | { readonly type: 'task_saved'; readonly templateId: number; readonly name: string; readonly revisionNumber: number; readonly at: string }
  | { readonly type: 'reuse_started'; readonly templateName: string; readonly revisionNumber: number; readonly digestShort: string; readonly asOfDate: string; readonly timeZone: string; readonly compatibilityStatus: string; readonly advisoryHeadlines: readonly string[]; readonly runtimeChanged: boolean; readonly asOfNotRecorded?: boolean; readonly at: string }
  | { readonly type: 'disclosure_sent'; readonly transmissionId: number; readonly kind: 'context' | 'diagnostics'; readonly provider: string; readonly model: string; readonly byteSize: number; readonly summary: unknown; readonly at: string }
);
export type ConversationEventFromSchema = Static<
  typeof ConversationEventSchema
>;
/** Any persisted event before the repository assigns its sequence number. */
export type UnnumberedConversationEvent = {
  [Kind in ConversationEvent['type']]: Omit<Extract<ConversationEvent, { readonly type: Kind }>, 'seq'>;
}[ConversationEvent['type']];

/** The five kinds FEAT-102's `AgentEvent` union produces. The `satisfies` clause below fails to compile if the two drift. */
export const AGENT_EVENT_TYPES = ['tool_started', 'tool_finished', 'assistant_text', 'turn_finished', 'failed'] as const;
type AgentEventTypeCheck = [AgentEvent['type']] extends [(typeof AGENT_EVENT_TYPES)[number]] ? ([(typeof AGENT_EVENT_TYPES)[number]] extends [AgentEvent['type']] ? true : never) : never;
export const AGENT_EVENT_TYPES_MATCH: AgentEventTypeCheck = true;

/** One row of the `conversation_event_kind` lookup table: who produces the kind, and which feature added it. */
export interface ConversationEventKindRow {
  readonly kind: ConversationEvent['type'];
  readonly owner: 'agent' | 'app';
  readonly addedIn: string;
}

/**
 * Every persisted event kind, in the order they were introduced. Migration
 * `0007` seeds `conversation_event_kind` with exactly these rows (a test
 * compares the two), and every kind after FEAT-109 is an INSERT, never a
 * table rebuild.
 */
export const CONVERSATION_EVENT_KINDS: readonly ConversationEventKindRow[] = Object.freeze([
  { kind: 'user_prompt', owner: 'app', addedIn: 'FEAT-103' },
  { kind: 'state_changed', owner: 'app', addedIn: 'FEAT-103' },
  { kind: 'tool_started', owner: 'agent', addedIn: 'FEAT-103' },
  { kind: 'tool_finished', owner: 'agent', addedIn: 'FEAT-103' },
  { kind: 'assistant_text', owner: 'agent', addedIn: 'FEAT-103' },
  { kind: 'turn_finished', owner: 'agent', addedIn: 'FEAT-103' },
  { kind: 'failed', owner: 'agent', addedIn: 'FEAT-103' },
  { kind: 'clarification_requested', owner: 'app', addedIn: 'FEAT-105' },
  { kind: 'clarification_answered', owner: 'app', addedIn: 'FEAT-105' },
  { kind: 'disclosure_sent', owner: 'app', addedIn: 'FEAT-105' },
  { kind: 'code_version_sealed', owner: 'app', addedIn: 'FEAT-106' },
  { kind: 'test_run_finished', owner: 'app', addedIn: 'FEAT-106' },
  { kind: 'generation_settled', owner: 'app', addedIn: 'FEAT-106' },
  { kind: 'verification_finished', owner: 'app', addedIn: 'FEAT-107' },
  { kind: 'approval_decided', owner: 'app', addedIn: 'FEAT-107' },
  { kind: 'run_finished', owner: 'app', addedIn: 'FEAT-107' },
  { kind: 'review_decided', owner: 'app', addedIn: 'FEAT-107' },
  { kind: 'runtime_prepared', owner: 'app', addedIn: 'FEAT-108' },
  { kind: 'artifacts_registered', owner: 'app', addedIn: 'FEAT-109' },
  { kind: 'reuse_started', owner: 'app', addedIn: 'FEAT-111' },
  { kind: 'task_saved', owner: 'app', addedIn: 'FEAT-111' },
]);
