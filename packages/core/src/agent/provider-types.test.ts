import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentUsage } from './provider-types';

/** Every member of the closed event union, one of each, for round-trip and width assertions. */
const EVENTS: readonly AgentEvent[] = [
  { type: 'tool_started', callId: 'call-1', tool: 'status', input: { deep: { value: 1 } }, at: '2026-09-22T00:00:00.000Z' },
  { type: 'tool_finished', callId: 'call-1', tool: 'status', output: ['a', 'b'], isError: false, at: '2026-09-22T00:00:01.000Z' },
  { type: 'assistant_text', text: 'Summary of the run.', at: '2026-09-22T00:00:02.000Z' },
  { type: 'turn_finished', usage: { turns: 1, inputTokens: 10, outputTokens: 4, costUsd: 0.002 }, at: '2026-09-22T00:00:03.000Z' },
  { type: 'failed', error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'The provider reported an error.' }, at: '2026-09-22T00:00:04.000Z' },
];

describe('agent provider seam', () => {
  it('has exactly five event members, so widening the seam fails the build', () => {
    expectTypeOf<AgentEvent['type']>().toEqualTypeOf<'tool_started' | 'tool_finished' | 'assistant_text' | 'turn_finished' | 'failed'>();
    expect(new Set(EVENTS.map((event) => event.type)).size).toBe(5);
  });
  it('keeps the terminal outcome union closed', () => {
    expectTypeOf<AgentRunResult['outcome']>().toEqualTypeOf<'completed' | 'failed' | 'aborted'>();
  });
  it.each(EVENTS.map((event) => [event.type, event] as const))('%s survives a JSON round-trip', (_type, event) => {
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
  it('gives every event an ISO-8601 timestamp', () => {
    for (const event of EVENTS) expect(new Date(event.at).toISOString()).toBe(event.at);
  });
  it('treats optional usage fields as genuinely absent rather than zero', () => {
    const usage: AgentUsage = { turns: 2 };
    expect(Object.keys(usage)).toEqual(['turns']);
    expect(JSON.stringify(usage)).toBe('{"turns":2}');
  });
  it('types tool payloads as unknown, not any', () => {
    const started = EVENTS[0];
    if (started?.type !== 'tool_started') throw new Error('fixture order changed');
    expectTypeOf(started.input).toEqualTypeOf<unknown>();
  });
});
