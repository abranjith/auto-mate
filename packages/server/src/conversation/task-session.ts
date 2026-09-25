import {
  AutoMateError,
  type AgentAuthSelection,
  type AgentError,
  type AgentEvent,
  type AgentModelSelection,
  type AgentProvider,
  type AgentRunResult,
  type AgentSession,
  type ConversationEvent,
  type ExecutionStatus,
  type UnnumberedConversationEvent,
} from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import type { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import type {
  ExecutionRepository,
  ExecutionRow,
} from '../db/repositories/execution-repository';
import type { TaskRow } from '../db/repositories/task-repository';
import type { BuiltRun, RunLifecycle, RunSettlement, RunStrategy } from './run-strategy';
import { openProviderSession, runProviderSession } from '../disclosure/disclosure-run-strategy';
import { TextCoalescer } from './text-coalescer';
import { elideToolInput, redactionsFor } from './tool-elision';

type ApplicationEvent =
  | { readonly type: 'user_prompt'; readonly text: string; readonly at: string }
  | {
      readonly type: 'state_changed';
      readonly from: ExecutionStatus;
      readonly to: ExecutionStatus;
      readonly at: string;
    };

export interface TaskSessionDependencies {
  execution: ExecutionRow;
  task: TaskRow;
  provider: AgentProvider;
  executions: ExecutionRepository;
  events: ConversationEventRepository;
  strategy: RunStrategy;
  paths: AppPaths;
  model: AgentModelSelection;
  auth: AgentAuthSelection;
  logger: Logger;
  clock?: () => Date;
}

/** Own one provider session, durable event sequence, and live subscriber set. */
export class TaskSession {
  private readonly subscribers = new Set<(event: ConversationEvent) => void>();
  private readonly clock: () => Date;
  private readonly coalescer: TextCoalescer;
  private nextSeq: number;
  private agentSession: AgentSession | undefined;
  private lifecycle: RunLifecycle | undefined;
  private redactions: ReadonlyMap<string, readonly string[]> = new Map();
  private stopError: AutoMateError | null = null;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private deadlineArmed = false;
  private started = false;
  private aborting = false;
  readonly settled: Promise<ExecutionRow>;
  private resolveSettled!: (row: ExecutionRow) => void;
  private rejectSettled!: (error: unknown) => void;

  constructor(private readonly deps: TaskSessionDependencies) {
    this.clock = deps.clock ?? (() => new Date());
    this.nextSeq = deps.events.maxSeq(deps.execution.id) + 1;
    this.coalescer = new TextCoalescer((event) => this.record(event));
    this.settled = new Promise((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
  }

  get executionId(): number {
    return this.deps.execution.id;
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }
  subscribe(listener: (event: ConversationEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Start the run once and resolve when its final state is persisted. */
  start(): Promise<ExecutionRow> {
    if (this.started) return this.settled;
    this.started = true;
    void this.run().then(this.resolveSettled, this.rejectSettled);
    return this.settled;
  }

  /** Ask the run to abort at most once: application work in flight first, then the provider. */
  async abort(): Promise<void> {
    if (this.aborting) return;
    this.aborting = true;
    this.lifecycle?.cancel();
    await this.agentSession?.abort();
  }

  /** Stop the run because a lifecycle limit was reached; it settles with `error`. */
  private stop(error: AutoMateError): void {
    if (this.stopError || this.aborting) return;
    this.stopError = error;
    this.deps.logger.warn({ executionId: this.executionId, code: error.code }, 'run stopped at a limit');
    this.lifecycle?.cancel();
    void this.agentSession?.abort();
  }

  private async run(): Promise<ExecutionRow> {
    let unsubscribe: (() => void) | undefined;
    const failure: { value: AgentError | null } = { value: null };
    try {
      const built = await this.begin();
      const session = await this.open(built);
      unsubscribe = session.subscribe((event) => {
        if (event.type === 'failed') failure.value = event.error;
        this.consume(event);
      });
      this.armDeadline();
      const result = await runProviderSession(session, built.prompt);
      this.coalescer.flush();
      return this.finish(result, failure.value);
    } catch (cause) {
      return this.fail(cause);
    } finally {
      this.deadlineArmed = false;
      this.disarmDeadline();
      unsubscribe?.();
      this.coalescer.dispose();
      await this.agentSession?.close();
    }
  }

  /** Enter `generating`, record the person's words, and build the run. */
  private async begin(): Promise<BuiltRun> {
    this.deps.executions.markStarted(this.executionId);
    this.state(this.deps.execution.status as ExecutionStatus, 'generating');
    this.record({ type: 'user_prompt', text: this.deps.task.description, at: this.now() });
    if (this.deps.execution.guidance) this.record({ type: 'user_prompt', text: this.deps.execution.guidance, at: this.now() });
    const built = await this.deps.strategy.buildRun(this.deps.task, this.deps.execution);
    this.lifecycle = built.lifecycle;
    this.redactions = redactionsFor(built.customTools);
    for (const event of built.events ?? []) this.record(event);
    return built;
  }

  private async open(built: BuiltRun): Promise<AgentSession> {
    const session = await openProviderSession(this.deps.provider, {
      executionId: String(this.executionId),
      sessionDir: this.deps.paths.sessionDirFor(String(this.executionId)),
      cwd: this.deps.paths.root,
      model: this.deps.model,
      auth: this.deps.auth,
      systemPrompt: built.systemPrompt ?? '',
      customTools: built.customTools,
    });
    this.agentSession = session;
    if (this.aborting) {
      this.lifecycle?.cancel();
      await session.abort();
    }
    this.deps.executions.markSessionOpened(this.executionId, { sessionId: session.id, logPath: session.logPath, provider: this.deps.model.provider, model: this.deps.model.id });
    return session;
  }

  /** Start the lifecycle's wall clock, when it has one. */
  private armDeadline(): void {
    const lifecycle = this.lifecycle;
    const remaining = lifecycle?.timeRemainingMs?.();
    if (!lifecycle?.timeoutError || remaining === undefined) return;
    this.deadlineArmed = true;
    this.disarmDeadline();
    this.deadline = setTimeout(() => this.stop(lifecycle.timeoutError!()), Math.max(0, remaining));
  }

  private disarmDeadline(): void {
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  /** A parked run waits for a person without a deadline; the clock resumes with what was left when the run continues. */
  private onStatus(to: ExecutionStatus): void {
    if (!this.lifecycle) return;
    this.lifecycle.onStatusChanged?.(to);
    if (to === 'waiting') this.disarmDeadline();
    else if (to === 'generating' && this.deadlineArmed) this.armDeadline();
  }

  /** Persist the terminal state the provider result — and the lifecycle, when present — decides. */
  private finish(result: AgentRunResult, failure: AgentError | null): ExecutionRow {
    const settlement: RunSettlement = this.lifecycle
      ? this.lifecycle.settle({ outcome: result.outcome, stopError: this.stopError, failure })
      : { status: result.outcome, ...(failure && result.outcome === 'failed' ? { error: failure } : {}), events: [] };
    for (const event of settlement.events) this.record(event);
    if (settlement.error && failure === null) this.record({ type: 'failed', error: settlement.error, at: this.now() });
    const current = this.currentStatus();
    const row = settlement.status === 'verifying'
      ? this.deps.executions.markHandedOff(this.executionId, settlement.status, result.usage)
      : this.deps.executions.markSettled(this.executionId, { status: settlement.status, usage: result.usage, ...(settlement.error ? { errorCode: settlement.error.code, errorMessage: settlement.error.message } : {}) });
    this.state(current, settlement.status);
    return row;
  }

  private fail(cause: unknown): ExecutionRow {
    this.coalescer.flush();
    this.lifecycle?.cancel();
    const current = this.currentStatus();
    const code = cause instanceof AutoMateError ? cause.code : 'AGENT_SESSION_START_FAILED';
    const message = cause instanceof AutoMateError ? cause.message : 'The agent session could not complete this run.';
    if (!(cause instanceof AutoMateError)) this.deps.logger.error({ err: cause, executionId: this.executionId }, 'task session failed');
    const settlement = this.lifecycle?.settle({ outcome: 'failed', stopError: null, failure: { code, message } });
    for (const event of settlement?.events ?? []) this.record(event);
    const row = this.deps.executions.markSettled(this.executionId, { status: 'failed', errorCode: code, errorMessage: message });
    this.record({ type: 'failed', error: { code, message }, at: this.now() });
    this.state(current, 'failed');
    return row;
  }

  private consume(event: AgentEvent): void {
    if (event.type === 'assistant_text') {
      this.coalescer.push(event);
      return;
    }
    if (event.type === 'turn_finished') {
      const stop = this.lifecycle?.onTurnFinished?.(event.usage);
      if (stop) this.stop(stop);
    }
    this.coalescer.flush();
    // Elide BEFORE persisting, and therefore before broadcasting: persist-then-broadcast is FEAT-103's invariant.
    const keys = event.type === 'tool_started' ? this.redactions.get(event.tool) : undefined;
    this.record(keys && event.type === 'tool_started' ? { ...event, input: elideToolInput(event.input, keys) } : event);
  }
  private currentStatus(): ExecutionStatus {
    return (this.deps.executions.getById(this.executionId)?.status ?? 'generating') as ExecutionStatus;
  }
  private now(): string {
    return this.clock().toISOString();
  }
  private state(from: ExecutionStatus, to: ExecutionStatus): void {
    this.record({ type: 'state_changed', from, to, at: this.now() });
  }
  /** Persist and broadcast an application event through the same ordered path as provider events. */
  appendApplicationEvent(event: UnnumberedConversationEvent): void {
    this.coalescer.flush();
    this.record(event);
  }

  private record(event: AgentEvent | ApplicationEvent | UnnumberedConversationEvent): void {
    const numbered = { ...event, seq: this.nextSeq } as ConversationEvent;
    this.nextSeq += 1;
    this.deps.events.append(this.executionId, numbered);
    if (numbered.type === 'state_changed') this.onStatus(numbered.to);
    for (const listener of [...this.subscribers]) {
      try {
        listener(numbered);
      } catch (cause) {
        this.deps.logger.warn(
          {
            cause,
            executionId: this.executionId,
            kind: numbered.type,
            seq: numbered.seq,
          },
          'conversation subscriber threw',
        );
      }
    }
  }
}
