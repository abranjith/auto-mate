import { describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createSanitizer } from '@automate/core';
import { createDefaultEventMapContext, extractTerminalState, mapPiEvent, type PiEventMapContext } from './event-map';
import { assistantMessage as assistant, rawEvent as raw } from './testing/stub-pi-session';

const AT = '2026-09-22T12:00:00.000Z';

/** A context whose sanitizer tags its output, so a mapper that bypassed it would be visible. */
function taggingContext(): PiEventMapContext {
  return {
    sanitizeText: (text) => `<sanitized>${text}`,
    sanitizePayload: (payload) => ({ sanitized: payload }),
    now: () => AT,
  };
}

/** The production context, to prove the real sanitizer is wired in. */
const realContext = createDefaultEventMapContext(createSanitizer({ knownSecrets: ['top-secret-value'] }), () => AT);

describe('pi event mapping', () => {
  describe('tool_execution_start', () => {
    it('produces exactly one tool_started with the right fields', () => {
      const events = mapPiEvent(raw({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'status', args: { a: 1 } }), taggingContext());
      expect(events).toEqual([{ type: 'tool_started', callId: 'call-1', tool: 'status', input: { sanitized: { a: 1 } }, at: AT }]);
    });
    it('passes tool arguments through the sanitizer', () => {
      const [event] = mapPiEvent(raw({ type: 'tool_execution_start', toolCallId: 'c', toolName: 't', args: { key: 'top-secret-value' } }), realContext);
      expect(JSON.stringify(event)).not.toContain('top-secret-value');
      expect(event).toMatchObject({ input: { key: '[redacted]' } });
    });
  });

  describe('tool_execution_end', () => {
    it('produces exactly one tool_finished and passes isError through', () => {
      const events = mapPiEvent(raw({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'status', result: 'ok', isError: true }), taggingContext());
      expect(events).toEqual([{ type: 'tool_finished', callId: 'call-1', tool: 'status', output: { sanitized: 'ok' }, isError: true, at: AT }]);
    });
    it('passes tool results through the sanitizer', () => {
      const [event] = mapPiEvent(raw({ type: 'tool_execution_end', toolCallId: 'c', toolName: 't', result: { out: 'top-secret-value' }, isError: false }), realContext);
      expect(JSON.stringify(event)).not.toContain('top-secret-value');
    });
  });

  describe('message_update', () => {
    it('produces one assistant_text for a text delta', () => {
      const events = mapPiEvent(raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }), taggingContext());
      expect(events).toEqual([{ type: 'assistant_text', text: '<sanitized>Hello', at: AT }]);
    });
    it('produces zero events for a thinking delta', () => {
      expect(mapPiEvent(raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' } }), taggingContext())).toEqual([]);
    });
    it('produces zero events for a delta that is not a string', () => {
      expect(mapPiEvent(raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 42 } }), taggingContext())).toEqual([]);
    });
  });

  describe('turn_end', () => {
    it('produces one turn_finished carrying the turn usage', () => {
      const events = mapPiEvent(raw({ type: 'turn_end', message: assistant({ usage: { input: 120, output: 30, cost: { total: 0.004 } } }), toolResults: [] }), taggingContext());
      expect(events).toEqual([{ type: 'turn_finished', usage: { turns: 1, inputTokens: 120, outputTokens: 30, costUsd: 0.004 }, at: AT }]);
    });
    it('omits token and cost fields entirely when the provider reported none', () => {
      const [event] = mapPiEvent(raw({ type: 'turn_end', message: assistant(), toolResults: [] }), taggingContext());
      if (event?.type !== 'turn_finished') throw new Error('expected a turn_finished event');
      expect(Object.keys(event.usage)).toEqual(['turns']);
      expect(event.usage.turns).toBe(1);
    });
    it('does not fold cache read and write tokens into the fresh counts', () => {
      const [event] = mapPiEvent(raw({ type: 'turn_end', message: assistant({ usage: { input: 10, output: 2, cacheRead: 900, cacheWrite: 400 } }), toolResults: [] }), taggingContext());
      if (event?.type !== 'turn_finished') throw new Error('expected a turn_finished event');
      expect(event.usage).toEqual({ turns: 1, inputTokens: 10, outputTokens: 2 });
    });
  });

  describe('agent_end', () => {
    it('produces zero events while an auto-retry is in flight', () => {
      expect(mapPiEvent(raw({ type: 'agent_end', willRetry: true, messages: [assistant({ stopReason: 'error', errorMessage: 'overloaded' })] }), taggingContext())).toEqual([]);
    });
    it('produces one failed carrying AGENT_PROVIDER_UNAVAILABLE for a terminal error', () => {
      const events = mapPiEvent(raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'error', errorMessage: 'overloaded' })] }), taggingContext());
      expect(events).toEqual([{ type: 'failed', error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: '<sanitized>overloaded' }, at: AT }]);
    });
    it('falls back to a plain message when the provider named no reason', () => {
      const [event] = mapPiEvent(raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'error' })] }), taggingContext());
      if (event?.type !== 'failed') throw new Error('expected a failed event');
      expect(event.error.message).toBe('The provider reported an error.');
    });
    it('produces zero events for a normal stop', () => {
      expect(mapPiEvent(raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'stop' })] }), taggingContext())).toEqual([]);
    });
  });

  describe('drift tolerance', () => {
    it.each(['tool_execution_update', 'agent_start', 'turn_start', 'message_start', 'message_end', 'compaction_start', 'auto_retry_start', 'queue_update', 'a_type_from_a_future_sdk'])(
      'produces zero events and does not throw for %s',
      (type) => {
        expect(() => mapPiEvent(raw({ type }), taggingContext())).not.toThrow();
        expect(mapPiEvent(raw({ type }), taggingContext())).toEqual([]);
      },
    );
  });

  it('stamps every emitted event with an ISO-8601 time from the injected clock', () => {
    const samples: AgentSessionEvent[] = [
      raw({ type: 'tool_execution_start', toolCallId: 'c', toolName: 't', args: {} }),
      raw({ type: 'tool_execution_end', toolCallId: 'c', toolName: 't', result: null, isError: false }),
      raw({ type: 'message_update', message: assistant(), assistantMessageEvent: { type: 'text_delta', delta: 'x' } }),
      raw({ type: 'turn_end', message: assistant(), toolResults: [] }),
      raw({ type: 'agent_end', willRetry: false, messages: [assistant({ stopReason: 'error' })] }),
    ];
    const emitted = samples.flatMap((event) => mapPiEvent(event, taggingContext()));
    expect(emitted).toHaveLength(5);
    for (const event of emitted) expect(new Date(event.at).toISOString()).toBe(AT);
  });
});

describe('terminal state extraction', () => {
  it('returns the last assistant message reason when several are present', () => {
    const messages = [assistant({ stopReason: 'stop' }), { role: 'user' }, assistant({ stopReason: 'error', errorMessage: 'final failure' })];
    expect(extractTerminalState(messages, taggingContext())).toEqual({ stopReason: 'error', errorMessage: '<sanitized>final failure' });
  });
  it('defaults to stop on an empty message list', () => {
    expect(extractTerminalState([], taggingContext())).toEqual({ stopReason: 'stop' });
  });
  it('defaults to stop when no assistant message is present', () => {
    expect(extractTerminalState([{ role: 'user' }], taggingContext())).toEqual({ stopReason: 'stop' });
  });
  it('defaults to stop when the assistant message names no reason', () => {
    expect(extractTerminalState([assistant()], taggingContext())).toEqual({ stopReason: 'stop' });
  });
  it('omits an empty error message rather than emitting a blank one', () => {
    expect(extractTerminalState([assistant({ stopReason: 'error', errorMessage: '' })], taggingContext())).toEqual({ stopReason: 'error' });
  });
  it('sanitizes the provider error message', () => {
    const state = extractTerminalState([assistant({ stopReason: 'error', errorMessage: 'failed with top-secret-value' })], realContext);
    expect(state.errorMessage).not.toContain('top-secret-value');
  });
});
