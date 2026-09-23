import { Type } from '@sinclair/typebox';
import {
  ConversationEventSchema,
  type ConversationEvent,
} from './conversation-event';
import {
  ExecutionSummarySchema,
  type ExecutionSummary,
} from '../contracts/task-api';

export const ServerToClientMessageSchema = Type.Union([
  Type.Object({
    type: Type.Literal('snapshot'),
    execution: ExecutionSummarySchema,
    events: Type.Array(ConversationEventSchema),
    lastSeq: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({ type: Type.Literal('event'), event: ConversationEventSchema }),
  Type.Object({
    type: Type.Literal('execution_updated'),
    execution: ExecutionSummarySchema,
  }),
]);
export type ServerToClientMessage =
  | {
      readonly type: 'snapshot';
      readonly execution: ExecutionSummary;
      readonly events: readonly ConversationEvent[];
      readonly lastSeq: number;
    }
  | { readonly type: 'event'; readonly event: ConversationEvent }
  | {
      readonly type: 'execution_updated';
      readonly execution: ExecutionSummary;
    };
export const WS_CLOSE = {
  NORMAL: 1000,
  NOT_FOUND: 4004,
  TRY_AGAIN: 1013,
} as const;
export function executionSocketPath(executionId: number, afterSeq = 0): string {
  return `/api/ws/executions/${executionId}?afterSeq=${afterSeq}`;
}
