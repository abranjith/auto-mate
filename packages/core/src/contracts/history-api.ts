import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { EXECUTION_STATUSES } from '../conversation/execution-state';
import { HISTORY_SEARCH_MAX_CHARS } from '../history/limits';

const Id = Type.Integer({ minimum: 1 });
const Count = Type.Integer({ minimum: 0 });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Status = Type.Union(EXECUTION_STATUSES.map((status) => Type.Literal(status)));
const Trigger = Type.Union([Type.Literal('manual'), Type.Literal('rerun'), Type.Literal('feedback')]);
const Cursor = Type.String({ pattern: '^[1-9][0-9]*$' });
const PageLimit = Type.String({ pattern: '^(?:[1-9]|[1-4][0-9]|50)$' });
const Reuse = Nullable(Type.Object({ kind: Type.Union([Type.Literal('run'), Type.Literal('replay'), Type.Literal('repair')]), templateId: Nullable(Id), templateName: Type.String(), revisionNumber: Id }));
const AsOf = Nullable(Type.Object({ at: Type.Integer(), date: Type.String(), timeZone: Type.String(), source: Type.Union([Type.Literal('now'), Type.Literal('chosen'), Type.Literal('copied')]) }));

/** Query for the task-level History list. All filtering is server-side. */
export const TaskHistoryQuerySchema = Type.Object({
  cursor: Type.Optional(Cursor),
  limit: Type.Optional(PageLimit),
  status: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('needs_you'), Type.Literal('running'), Type.Literal('done'), Type.Literal('stopped')])),
  q: Type.Optional(Type.String({ maxLength: HISTORY_SEARCH_MAX_CHARS })),
}, { additionalProperties: false });

export const RunTimelineQuerySchema = Type.Object({ cursor: Type.Optional(Cursor), limit: Type.Optional(PageLimit) }, { additionalProperties: false });

export const TaskHistoryItemSchema = Type.Object({
  task: Type.Object({ id: Id, name: Type.String(), createdAt: Type.String() }),
  latestRun: Type.Object({
    id: Id, status: Status, trigger: Trigger, createdAt: Type.String(),
    completedAt: Nullable(Type.String()), durationMs: Nullable(Count),
    errorCode: Nullable(Type.String()), statusSince: Nullable(Type.String()), reuse: Reuse,
  }),
  runCount: Count, inputCount: Count, latestOutputCount: Count,
});

export const TaskHistoryPageSchema = Type.Object({
  items: Type.Array(TaskHistoryItemSchema), nextCursor: Nullable(Cursor), hasMore: Type.Boolean(),
});

export const RunTimelineItemSchema = Type.Object({
  id: Id, taskId: Id, status: Status, trigger: Trigger,
  retryOfExecutionId: Nullable(Id), hasGuidance: Type.Boolean(), hasReviewFeedback: Type.Boolean(),
  createdAt: Type.String(), completedAt: Nullable(Type.String()), durationMs: Nullable(Count),
  errorCode: Nullable(Type.String()), outputCount: Count, reuse: Reuse,
});

export const RunTimelinePageSchema = Type.Object({
  items: Type.Array(RunTimelineItemSchema), nextCursor: Nullable(Cursor), hasMore: Type.Boolean(),
});

/** A small provenance summary. Payloads remain on their owning feature routes. */
export const RunRecordSchema = Type.Object({
  execution: Type.Object({
    id: Id, taskId: Id, status: Status, trigger: Trigger, retryOfExecutionId: Nullable(Id),
    provider: Nullable(Type.String()), model: Nullable(Type.String()),
    createdAt: Type.String(), startedAt: Nullable(Type.String()), completedAt: Nullable(Type.String()),
    durationMs: Nullable(Count), errorCode: Nullable(Type.String()), errorMessage: Nullable(Type.String()),
  }),
  personWords: Type.Object({ guidance: Nullable(Type.String()), reviewFeedback: Nullable(Type.String()) }),
  chain: Type.Object({ previous: Nullable(Id), next: Type.Array(Id) }),
  inputs: Type.Array(Type.Object({ id: Id, originalFilename: Type.String(), format: Type.String(), byteSize: Count, sha256: Type.String() })),
  inputsReadByRun: Nullable(Type.Boolean()),
  disclosure: Nullable(Type.Object({ provider: Nullable(Type.String()), model: Nullable(Type.String()), sendCount: Count, grantedAt: Nullable(Type.String()) })),
  // Questions by where their answer came from: the person, an earlier run of this task, or the proposed default.
  questions: Nullable(Type.Object({ total: Count, answered: Count, byPerson: Count, seeded: Count, defaulted: Count, declined: Count })),
  code: Nullable(Type.Object({ id: Id, attempt: Count, digest: Type.String(), shortDigest: Type.String(), testsPassed: Nullable(Type.Boolean()), attemptCount: Count })),
  checks: Nullable(Type.Object({ status: Type.String(), blockingCount: Count, advisoryCount: Count, summary: Type.String(), runtime: Nullable(Type.String()) })),
  approval: Nullable(Type.Object({ decidedAt: Type.String(), acknowledgedWarnings: Type.Boolean() })),
  scriptRun: Nullable(Type.Object({ status: Type.String(), exitCode: Nullable(Type.Integer()), durationMs: Nullable(Count), limitBreach: Nullable(Type.String()), outputTruncated: Type.Boolean(), declaredOutputCount: Count, producedOutputCount: Count, artifactCount: Count, unregisteredOutputCount: Count })),
  outputs: Nullable(Type.Object({ count: Count })),
  transcript: Type.Object({ lastSeq: Count }),
  reuse: Nullable(Type.Object({ kind: Type.Union([Type.Literal('run'), Type.Literal('replay'), Type.Literal('repair')]), templateId: Nullable(Id), templateName: Type.String(), revisionNumber: Id, revisionDigestShort: Type.String(), compatibility: Nullable(Type.Object({ status: Type.String(), advisoryCount: Count })), instructions: Nullable(Type.Array(Type.String())) })),
  asOf: AsOf,
});

export const TaskCountsSchema = Type.Object({
  runs: Count, inputs: Count, outputs: Count, openRunId: Nullable(Id),
  /** FEAT-111: names of saved tasks with a revision saved from this task's runs; they survive its deletion. */
  savedAs: Type.Optional(Type.Array(Type.String())),
});

export const DeleteTaskResponseSchema = Type.Object({
  taskId: Id,
  removed: Type.Object({ runs: Count, inputs: Count, outputs: Count }),
  filesPendingRemoval: Count,
});

export type TaskHistoryQuery = Static<typeof TaskHistoryQuerySchema>;
export type TaskHistoryItem = Static<typeof TaskHistoryItemSchema>;
export type TaskHistoryPage = Static<typeof TaskHistoryPageSchema>;
export type RunTimelineQuery = Static<typeof RunTimelineQuerySchema>;
export type RunTimelineItem = Static<typeof RunTimelineItemSchema>;
export type RunTimelinePage = Static<typeof RunTimelinePageSchema>;
export type RunRecord = Static<typeof RunRecordSchema>;
export type TaskCounts = Static<typeof TaskCountsSchema>;
export type DeleteTaskResponse = Static<typeof DeleteTaskResponseSchema>;
