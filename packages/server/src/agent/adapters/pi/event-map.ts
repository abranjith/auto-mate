/**
 * Pi session event to normalized `AgentEvent` mapping (FEAT-102 TASK-006).
 *
 * This file is the de-facto specification for any future second adapter: every
 * mapping decision is documented inline. The invariant it enforces is that
 * EVERY payload crossing the seam — tool inputs and outputs, assistant text,
 * error messages — passes the core sanitizer before emission. A raw Pi payload
 * is never forwarded.
 *
 * Deliberate exclusions, with their reasons:
 * - Thinking deltas: no consumer, and forwarding them would widen what must be
 *   sanitized, persisted, and rendered.
 * - `tool_execution_update` partial results: the seam models a tool call as a
 *   start/finish pair only.
 * - Compaction, queue, retry, branch, and summarization events: provider
 *   mechanics, observable in the raw session log when someone needs them.
 * - `agent_end` with `willRetry: true`: an in-flight auto-retry is not a
 *   failure; a later `agent_end` settles the run.
 */

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AgentError, AgentEvent, AgentUsage, Sanitizer } from '@automate/core';

/** Sanitization and clock dependencies, injectable for tests. */
export interface PiEventMapContext {
  /** Sanitize an arbitrary payload for emission. */
  readonly sanitizePayload: (payload: unknown) => unknown;
  /** Sanitize a text fragment for emission. */
  readonly sanitizeText: (text: string) => string;
  /** ISO-8601 timestamp source. */
  readonly now: () => string;
}

/** Terminal information extracted from a settled Pi run; drives the `AgentRunResult` outcome. */
export interface PiTerminalState {
  /** Provider stop reason of the final assistant message; `stop` when absent. */
  readonly stopReason: string;
  /** Sanitized provider error message, present when the run failed. */
  readonly errorMessage?: string;
}

/** Build the default mapping context over a core sanitizer. @param sanitizer The boundary sanitizer holding the resolved secrets. @param now Clock override for tests. @returns The mapping context. @example createDefaultEventMapContext(createSanitizer({ knownSecrets })) */
export function createDefaultEventMapContext(sanitizer: Sanitizer, now: () => string = () => new Date().toISOString()): PiEventMapContext {
  return { sanitizePayload: sanitizer.sanitizePayload, sanitizeText: sanitizer.sanitizeText, now };
}

/**
 * Map one Pi session event onto zero or more normalized seam events.
 *
 * | Pi event                                       | Emits            |
 * | ---------------------------------------------- | ---------------- |
 * | `tool_execution_start`                          | `tool_started`   |
 * | `tool_execution_end`                            | `tool_finished`  |
 * | `message_update` with a `text_delta`            | `assistant_text` |
 * | `turn_end`                                      | `turn_finished`  |
 * | `agent_end`, no retry pending, terminal `error` | `failed`         |
 * | everything else                                 | nothing          |
 *
 * @param event Raw Pi session event; never re-emitted as-is.
 * @param ctx Sanitizer and clock context.
 * @returns The normalized events to emit, in order. Possibly empty.
 * @example mapPiEvent(rawEvent, ctx).forEach(dispatch)
 */
export function mapPiEvent(event: AgentSessionEvent, ctx: PiEventMapContext): AgentEvent[] {
  switch (event.type) {
    case 'tool_execution_start':
      return [{ type: 'tool_started', callId: event.toolCallId, tool: event.toolName, input: ctx.sanitizePayload(event.args), at: ctx.now() }];

    case 'tool_execution_end':
      return [{ type: 'tool_finished', callId: event.toolCallId, tool: event.toolName, output: ctx.sanitizePayload(event.result), isError: event.isError, at: ctx.now() }];

    case 'message_update': {
      // Only assistant text deltas cross the seam. A credential split across two
      // deltas can evade shape detection here; the hard guarantee is the
      // exact-match scrub of the keys the server actually holds.
      const streamEvent: { type?: string; delta?: unknown } = event.assistantMessageEvent;
      if (streamEvent.type !== 'text_delta' || typeof streamEvent.delta !== 'string') return [];
      return [{ type: 'assistant_text', text: ctx.sanitizeText(streamEvent.delta), at: ctx.now() }];
    }

    case 'turn_end':
      return [{ type: 'turn_finished', usage: usageOfTurn(event.message), at: ctx.now() }];

    case 'agent_end': {
      if (event.willRetry) return [];
      const terminal = extractTerminalState(event.messages, ctx);
      if (terminal.stopReason !== 'error') return [];
      // A mid-run provider error (overload, exhausted retries, transport drop)
      // normalizes to the transport code. Startup problems never reach this
      // path — they are typed failures thrown from open().
      const error: AgentError = {
        code: 'AGENT_PROVIDER_UNAVAILABLE',
        message: terminal.errorMessage ?? 'The provider reported an error.',
      };
      return [{ type: 'failed', error, at: ctx.now() }];
    }

    default:
      // Drift tolerance: an unknown or unmapped Pi event is ignored, never
      // thrown on. A minor SDK addition must not break the seam.
      return [];
  }
}

/** The shape of an assistant message this mapper reads, without importing the SDK's message types. */
interface AssistantMessageShape {
  readonly role: 'assistant';
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly usage?: { readonly input?: unknown; readonly output?: unknown; readonly cost?: { readonly total?: unknown } };
}

/** Narrow an unknown message to the assistant shape. */
function isAssistantMessage(message: unknown): message is AssistantMessageShape {
  return typeof message === 'object' && message !== null && 'role' in message && (message as { role: unknown }).role === 'assistant';
}

/**
 * Extract the terminal stop reason and error of a settled run.
 *
 * @param messages The settled run's message list, walked backwards.
 * @param ctx Sanitizer context; an error message is a payload too.
 * @returns The last assistant message's stop reason, defaulting to `stop`.
 * @example extractTerminalState(event.messages, ctx).stopReason
 */
export function extractTerminalState(messages: readonly unknown[], ctx: PiEventMapContext): PiTerminalState {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    const stopReason = typeof message.stopReason === 'string' ? message.stopReason : 'stop';
    if (typeof message.errorMessage === 'string' && message.errorMessage.length > 0) {
      return { stopReason, errorMessage: ctx.sanitizeText(message.errorMessage) };
    }
    return { stopReason };
  }
  return { stopReason: 'stop' };
}

/**
 * Usage of one completed turn.
 *
 * `inputTokens`/`outputTokens` are the provider's fresh counts. Cache read and
 * write tokens are deliberately not folded in — the raw session log keeps the
 * full breakdown for whoever needs it. A field the provider did not report is
 * omitted entirely rather than materialized as zero.
 */
function usageOfTurn(message: unknown): AgentUsage {
  if (!isAssistantMessage(message) || message.usage === undefined) return { turns: 1 };
  const { usage } = message;
  return {
    turns: 1,
    ...(typeof usage.input === 'number' ? { inputTokens: usage.input } : {}),
    ...(typeof usage.output === 'number' ? { outputTokens: usage.output } : {}),
    ...(typeof usage.cost?.total === 'number' ? { costUsd: usage.cost.total } : {}),
  };
}
