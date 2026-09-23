// Browser-safe conversation contract. It may wrap AgentEvent, but must never
// import a provider SDK type. Every field must survive JSON round-tripping.
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { AgentEvent } from '../agent/provider-types';
import { EXECUTION_STATUSES, type ExecutionStatus } from './execution-state';

const At = Type.String();
const UnknownJson = Type.Unknown();
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
);
export type ConversationEventFromSchema = Static<
  typeof ConversationEventSchema
>;
