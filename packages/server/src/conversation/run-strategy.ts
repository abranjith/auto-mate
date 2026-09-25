import type { AgentError, AgentToolDefinition, AgentUsage, AutoMateError, ExecutionStatus, UnnumberedConversationEvent } from '@automate/core';
import type { ExecutionRow } from '../db/repositories/execution-repository';
import type { TaskRow } from '../db/repositories/task-repository';

/** How the provider run ended, plus why the application stopped it, if it did. */
export interface RunEnding {
  readonly outcome: 'completed' | 'failed' | 'aborted';
  /** Set when a lifecycle limit (wall clock, spend) stopped the run. */
  readonly stopError: AutoMateError | null;
  /** The provider's own failure, when it reported one. */
  readonly failure: AgentError | null;
}

/** The terminal state a lifecycle decides, and the events that explain it. */
export interface RunSettlement {
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly error?: { readonly code: string; readonly message: string };
  readonly events: readonly UnnumberedConversationEvent[];
}

/**
 * Optional per-run policy a strategy hands to `TaskSession` (FEAT-106).
 * `TaskSession` stays generic: it feeds usage, keeps the deadline, cancels
 * application work before the provider on abort, and asks how to settle.
 */
export interface RunLifecycle {
  /** Milliseconds left on the run's wall clock, measured now; undefined means no deadline. */
  timeRemainingMs?(): number;
  /** The error a run settles with when its wall clock expires. */
  timeoutError?(): AutoMateError;
  /** Told every status change the run records, so a wall clock can pause while a person is answering (`waiting`). */
  onStatusChanged?(to: ExecutionStatus): void;
  /** Feed one turn's usage. A returned error stops the run between turns. */
  onTurnFinished?(usage: AgentUsage): AutoMateError | null;
  /** Cancel in-flight application work (tests, environment preparation) before the provider session aborts. */
  cancel(): void;
  /** Decide the terminal state once the provider run has ended. */
  settle(ending: RunEnding): RunSettlement;
}

/** What a strategy builds for one run. */
export interface BuiltRun {
  prompt: string;
  systemPrompt?: string;
  customTools: readonly AgentToolDefinition[];
  events?: readonly UnnumberedConversationEvent[];
  lifecycle?: RunLifecycle;
}

/** Prompt/tool projection replaced by FEAT-106 without changing session orchestration. */
export interface RunStrategy {
  buildRun(task: TaskRow, execution: ExecutionRow): BuiltRun | Promise<BuiltRun>;
}

/** Send only the words the person typed and register no custom tools. */
export class PassthroughRunStrategy implements RunStrategy {
  buildRun(task: TaskRow): BuiltRun {
    return { prompt: task.description, customTools: [] };
  }
}
