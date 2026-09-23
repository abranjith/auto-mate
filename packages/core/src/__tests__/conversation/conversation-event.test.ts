import { Value } from '@sinclair/typebox/value';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CreateTaskRequestSchema,
  ExecutionSummarySchema,
} from '../../contracts/task-api';
import type { AgentEvent } from '../../agent/provider-types';
import {
  ConversationEventSchema,
  type ConversationEvent,
} from '../../conversation/conversation-event';

const at = '2026-09-22T12:00:00.000Z';
const agentEvents: AgentEvent[] = [
  { type: 'tool_started', callId: '1', tool: 'status', input: {}, at },
  {
    type: 'tool_finished',
    callId: '1',
    tool: 'status',
    output: {},
    isError: false,
    at,
  },
  { type: 'assistant_text', text: 'hello', at },
  { type: 'turn_finished', usage: { turns: 1 }, at },
  {
    type: 'failed',
    error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'Unavailable.' },
    at,
  },
];

describe('conversation contract', () => {
  it('validates and round-trips all seven event kinds', () => {
    const events: ConversationEvent[] = [
      ...agentEvents.map((event, index) => ({ ...event, seq: index + 1 })),
      { seq: 6, type: 'user_prompt', text: 'go', at },
      { seq: 7, type: 'state_changed', from: 'pending', to: 'generating', at },
    ];
    for (const event of events) {
      expect(Value.Check(ConversationEventSchema, event)).toBe(true);
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
    expectTypeOf<ConversationEvent['type']>().toEqualTypeOf<
      AgentEvent['type'] | 'user_prompt' | 'state_changed'
    >();
  });

  it('bounds and trims task prompts at the API boundary', () => {
    expect(Value.Check(CreateTaskRequestSchema, { prompt: '' })).toBe(false);
    expect(Value.Check(CreateTaskRequestSchema, { prompt: '   ' })).toBe(false);
    expect(
      Value.Check(CreateTaskRequestSchema, { prompt: 'x'.repeat(8001) }),
    ).toBe(false);
    expect(Value.Check(CreateTaskRequestSchema, { prompt: 'one\ntwo' })).toBe(
      true,
    );
  });

  it('has no session-log path field in execution responses', () => {
    expect(Object.keys(ExecutionSummarySchema.properties)).not.toContain(
      'agentLogPath',
    );
    expect(
      Object.keys(ExecutionSummarySchema.properties).every(
        (key) => !/path/i.test(key),
      ),
    ).toBe(true);
  });
});
