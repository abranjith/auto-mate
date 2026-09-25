import { Type, type Static } from '@sinclair/typebox';
import {
  ConversationEventSchema,
  type ConversationEvent,
} from '../conversation/conversation-event';
import { EXECUTION_STATUSES } from '../conversation/execution-state';
import { UPLOAD_LIMIT_DEFAULTS } from '../ingestion/limits';
import { DisclosureAckSchema, PreflightDecisionSchema } from './disclosure-api';

const StatusSchema = Type.Union(
  EXECUTION_STATUSES.map((status) => Type.Literal(status)),
);
export const CreateTaskRequestSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 8000, pattern: '.*\\S.*' }),
  /** Staged uploads to attach inside the transaction that creates the task (FEAT-104). */
  uploadIds: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), {
      maxItems: UPLOAD_LIMIT_DEFAULTS.maxFilesPerTask,
      uniqueItems: true,
    }),
  ),
  disclosureAck: Type.Optional(DisclosureAckSchema),
  preflightDecisions: Type.Optional(Type.Array(PreflightDecisionSchema)),
});
export const TaskSchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  description: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export const UsageSummarySchema = Type.Object({
  turns: Type.Optional(Type.Integer()),
  inputTokens: Type.Optional(Type.Integer()),
  outputTokens: Type.Optional(Type.Integer()),
  costUsd: Type.Optional(Type.Number()),
});
export const ExecutionSummarySchema = Type.Object({
  id: Type.Integer(),
  taskId: Type.Integer(),
  status: StatusSchema,
  provider: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  usage: UsageSummarySchema,
  startedAt: Type.Union([Type.String(), Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  error: Type.Union([
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      correlationId: Type.Optional(Type.String()),
    }),
    Type.Null(),
  ]),
  createdAt: Type.String(),
});
export const TaskResponseSchema = Type.Object({
  task: TaskSchema,
  executions: Type.Array(ExecutionSummarySchema),
});
export const CreateTaskResponseSchema = Type.Object({
  task: TaskSchema,
  execution: ExecutionSummarySchema,
});
export const ConversationEventPageSchema = Type.Object({
  events: Type.Array(ConversationEventSchema),
  lastSeq: Type.Integer({ minimum: 0 }),
  hasMore: Type.Boolean(),
});
export const AbortResponseSchema = ExecutionSummarySchema;
export type CreateTaskRequest = Static<typeof CreateTaskRequestSchema>;
export type Task = Static<typeof TaskSchema>;
export type ExecutionSummary = Static<typeof ExecutionSummarySchema>;
export type TaskResponse = Static<typeof TaskResponseSchema>;
export type CreateTaskResponse = Static<typeof CreateTaskResponseSchema>;
export type ConversationEventPage = {
  readonly events: readonly ConversationEvent[];
  readonly lastSeq: number;
  readonly hasMore: boolean;
};
