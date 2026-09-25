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
  it('validates and round-trips every event kind', () => {
    const events: ConversationEvent[] = [
      ...agentEvents.map((event, index) => ({ ...event, seq: index + 1 })),
      { seq: 6, type: 'user_prompt', text: 'go', at },
      { seq: 7, type: 'state_changed', from: 'pending', to: 'generating', at },
      { seq: 8, type: 'clarification_requested', clarificationId: 1, at },
      { seq: 9, type: 'clarification_answered', clarificationId: 1, at },
      { seq: 10, type: 'disclosure_sent', transmissionId: 1, kind: 'context', provider: 'test', model: 'fake', byteSize: 12, summary: {}, at },
      { seq: 11, type: 'code_version_sealed', codeVersionId: 1, attempt: 1, digest: 'a'.repeat(64), files: [{ path: 'main.py', role: 'script', byteSize: 84, lineCount: 4 }], at },
      { seq: 12, type: 'test_run_finished', attemptId: 1, attempt: 1, outcome: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, droppedLineCount: 14, attemptsRemaining: 2, attemptLimit: 3, manifestPresent: false, at },
      { seq: 13, type: 'test_run_finished', attemptId: 2, attempt: 4, outcome: 'refused', refusalReason: 'attempt_limit', testsTotal: null, testsPassed: null, testsFailed: null, droppedLineCount: null, attemptsRemaining: 0, attemptLimit: 3, manifestPresent: null, at },
      { seq: 14, type: 'generation_settled', outcome: 'finalized', codeVersionId: 1, digest: 'a'.repeat(64), attemptsUsed: 2, attemptLimit: 3, summary: 'Chose attempt 2 of 3.', at },
      { seq: 15, type: 'generation_settled', outcome: 'exhausted', codeVersionId: null, digest: null, attemptsUsed: 3, attemptLimit: 3, summary: 'Used all 3 attempts.', at },
    ];
    for (const event of events) {
      expect(Value.Check(ConversationEventSchema, event)).toBe(true);
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
    expectTypeOf<ConversationEvent['type']>().toEqualTypeOf<
      AgentEvent['type'] | 'user_prompt' | 'state_changed' | 'clarification_requested' | 'clarification_answered' | 'disclosure_sent' | 'code_version_sealed' | 'test_run_finished' | 'generation_settled'
    >();
  });

  it('keeps code and diagnostic text out of every generation event by construction', () => {
    const sealed = { seq: 1, type: 'code_version_sealed', codeVersionId: 1, attempt: 1, digest: 'b'.repeat(64), files: [{ path: 'main.py', role: 'script', byteSize: 1, lineCount: 1, content: 'print(1)' }], at };
    expect(Value.Check(ConversationEventSchema, sealed)).toBe(true);
    const keys = JSON.stringify(ConversationEventSchema);
    expect(keys).not.toMatch(/"(?:content|diagnostics|stdout|stderr)":/);
    expect(Value.Check(ConversationEventSchema, { seq: 1, type: 'generation_settled', outcome: 'maybe', codeVersionId: null, digest: null, attemptsUsed: 0, attemptLimit: 3, summary: '', at })).toBe(false);
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
