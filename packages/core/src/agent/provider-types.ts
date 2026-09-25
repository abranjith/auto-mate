import type { Static, TSchema } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// The Auto-Mate agent provider seam (FEAT-102, plan_mvp.md §2).
//
// Two invariants exist to be held here, and nowhere else:
//
//   1. No provider SDK type may be imported into this file. Provider types
//      never cross the seam; adapters translate in both directions and every
//      payload that arrives here is post-sanitizer.
//   2. No `AgentEvent` member may be added without a named consumer in a
//      later feature. The union is closed on purpose — widening it widens
//      what must be sanitized, persisted, and rendered forever after.
//
// Deliberately excluded: provider messages, thinking deltas, session trees,
// resource loaders, tool engines, model registries, compaction, and steering
// queues. None of those may be added without a demonstrated consumer.
// ---------------------------------------------------------------------------

/** Opens agent sessions against a concrete provider backend. */
export interface AgentProvider {
  /** Open a fresh agent session. @param options Per-session model, auth, and placement. @returns The live session. @throws AgentStartupError when the session cannot be established; never a degraded client. @example await provider.open({ executionId, sessionDir, cwd, model, auth, systemPrompt }) */
  open(options: AgentSessionOptions): Promise<AgentSession>;
}

/** A live provider-backed session owned by exactly one execution. */
export interface AgentSession {
  /** Provider-assigned session identity. */
  readonly id: string;
  /** Absolute path of the provider session log (JSONL), at its final location. */
  readonly logPath: string;
  /** Where the credential authenticating this session came from. */
  readonly authSource: AgentAuthSource;
  /** Run one prompt to completion, including tool calls. @param prompt Prompt text; callers sanitize inbound content before the seam. @returns Outcome, stop reason, and aggregated usage. Provider failures surface as `outcome: 'failed'`, not as a rejection. @throws Error only on caller misuse, such as running a closed session. @example await session.run('Summarize the profile.') */
  run(prompt: string): Promise<AgentRunResult>;
  /** Subscribe to normalized events. @param listener Receives every post-sanitizer event. @returns An unsubscribe function for this listener. @example const off = session.subscribe((e) => render(e)) */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Abort the in-flight run and wait for the provider loop to settle. @returns Nothing; idempotent and safe after close. @example await session.abort() */
  abort(): Promise<void>;
  /** Detach listeners, dispose the provider session, and finalize the log. @returns Nothing; idempotent. @example await session.close() */
  close(): Promise<void>;
}

/** Immutable configuration for opening one session. */
export interface AgentSessionOptions {
  /** Owning execution identity; the session is an artifact of this execution. */
  readonly executionId: string;
  /** Absolute directory the session JSONL is written into. */
  readonly sessionDir: string;
  /** Working directory recorded for the session; never used for resource discovery. */
  readonly cwd: string;
  /** Model to resolve at startup; an unknown model is a typed failure. */
  readonly model: AgentModelSelection;
  /** How provider credentials are resolved for this session. */
  readonly auth: AgentAuthSelection;
  /** The complete system prompt. No ambient prompt source is consulted. */
  readonly systemPrompt: string;
  /** Application-owned tools available to this session. */
  readonly customTools?: readonly AgentToolDefinition[];
}

/** SDK-free custom tool definition accepted by provider adapters. */
export interface AgentToolDefinition<TParameters extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  /**
   * Argument keys replaced by `{ elided: true, byteSize }` in the PERSISTED and broadcast `tool_started` event (FEAT-106).
   * `execute()` still receives every argument in full; this only keeps a large or sensitive argument, such as
   * generated code, out of the transcript when another table already holds the one authoritative copy.
   */
  readonly redactArgsInEvents?: readonly string[];
  execute(args: Static<TParameters>, context: { readonly executionId: string; readonly callId: string }): Promise<unknown>;
}

/** Provider and model coordinates plus optional reasoning effort. */
export interface AgentModelSelection {
  /** Provider key, for example `anthropic`. */
  readonly provider: string;
  /** Provider-scoped model identifier, for example `claude-sonnet-5`. */
  readonly id: string;
  /** Reasoning effort; validated against the adapter's levels at session open. */
  readonly thinking?: string;
}

/** Credential selection: the app-owned store, or an explicit personal Pi credential file. */
export type AgentAuthSelection =
  | { readonly mode: 'managed' }
  | { readonly mode: 'personal-pi'; readonly authPath: string };

/** The resolved origin of the credential that authenticated a session. */
export type AgentAuthSource = 'managed' | 'personal-pi' | 'environment';

/** Normalized session events. Closed union — every payload is post-sanitizer and JSON-serializable. */
export type AgentEvent =
  | {
      /** A tool invocation started. */
      readonly type: 'tool_started';
      /** Provider call identity; pairs this start with its finish. */
      readonly callId: string;
      /** Registered tool name. */
      readonly tool: string;
      /** Sanitized tool input. */
      readonly input: unknown;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** A tool invocation finished, successfully or not. */
      readonly type: 'tool_finished';
      /** Provider call identity; pairs this finish with its start. */
      readonly callId: string;
      /** Registered tool name. */
      readonly tool: string;
      /** Sanitized tool output. */
      readonly output: unknown;
      /** True when the tool returned an error result. */
      readonly isError: boolean;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** Incremental assistant text. */
      readonly type: 'assistant_text';
      /** Sanitized text delta. */
      readonly text: string;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** One provider turn completed. */
      readonly type: 'turn_finished';
      /** Usage for this turn; `turns` is 1. */
      readonly usage: AgentUsage;
      /** ISO-8601 timestamp. */
      readonly at: string;
    }
  | {
      /** The run failed; a terminal `failed` outcome follows. */
      readonly type: 'failed';
      /** Stable-coded, sanitized error. */
      readonly error: AgentError;
      /** ISO-8601 timestamp. */
      readonly at: string;
    };

/** Terminal result of one `AgentSession.run()`. */
export interface AgentRunResult {
  /** How the run ended. Closed union — no other terminal state exists. */
  readonly outcome: 'completed' | 'failed' | 'aborted';
  /** Provider stop reason; informational, not a stable contract. */
  readonly stopReason: string;
  /** Usage aggregated across every turn of this run. */
  readonly usage: AgentUsage;
}

/** Usage metrics. Optional fields appear only when the provider reported them. */
export interface AgentUsage {
  /** Number of completed provider turns. */
  readonly turns: number;
  /** Fresh input tokens, when reported. */
  readonly inputTokens?: number;
  /** Output tokens, when reported. */
  readonly outputTokens?: number;
  /** Provider-reported cost in USD, when reported. */
  readonly costUsd?: number;
}

/** A stable-coded, render-safe error carried by `failed` events. */
export interface AgentError {
  /** One of the stable `AGENT_*` codes in `ERROR_CODES`. */
  readonly code: string;
  /** Sanitized, plain-English message. Never contains key material. */
  readonly message: string;
}
