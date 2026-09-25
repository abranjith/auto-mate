import {
  ExecutionInterruptedError,
  ExecutionLimitReachedError,
  ExecutionNotRunningError,
  consumesConcurrencySlot,
  isTerminal,
  survivesRestart,
  type AgentAuthSelection,
  type AgentModelSelection,
  type AgentProvider,
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
import type { RunStrategy } from './run-strategy';
import { TaskSession } from './task-session';
import type { ClarificationService } from '../disclosure/clarification-service';

/**
 * Application work that runs after the provider session (FEAT-107): a
 * verification pass or a real-data run. It holds a concurrency slot while it
 * runs and is cancelled through the same abort path as a provider session.
 */
export interface PhaseJob {
  /** Cancel in-flight processes; the job settles its own rows and state. */
  abort(): void;
  /** Resolves once the job has settled its rows and the execution's state. */
  readonly settled: Promise<unknown>;
}

type Listener = (event: ConversationEvent) => void;

export interface TaskSessionRegistryDependencies {
  provider: AgentProvider;
  executions: ExecutionRepository;
  events: ConversationEventRepository;
  strategy: RunStrategy;
  paths: AppPaths;
  model: () => AgentModelSelection;
  auth: () => AgentAuthSelection;
  logger: Logger;
  maxConcurrentExecutions: number;
  clarifications?: ClarificationService;
  /** Tidies application state a crash or shutdown left mid-flight — a test run, a verification pass, a script run — before the execution is marked interrupted. */
  onInterrupted?: (executionId: number) => void;
  /** Called when a provider session settles in a non-terminal hand-off status (FEAT-107: `verifying`) so the next phase can start. */
  onHandOff?: (execution: ExecutionRow) => void;
}

/**
 * Registry enforcing one live session per execution and the configured cap.
 * It is also each execution's event fan-out: subscribers attach here, not to
 * a session, so events published after the provider session has closed —
 * verification, approval, the run, the review — still reach an open page.
 */
export class TaskSessionRegistry {
  private readonly sessions = new Map<number, TaskSession>();
  private readonly jobs = new Map<number, PhaseJob>();
  private readonly listeners = new Map<number, Set<Listener>>();
  constructor(private readonly deps: TaskSessionRegistryDependencies) {}

  assertCapacity(): void {
    if (this.activeCount() >= this.deps.maxConcurrentExecutions)
      throw new ExecutionLimitReachedError();
  }

  /** Live work holding a slot: sessions not parked on a person, plus running phase jobs. */
  activeCount(): number {
    const ids = new Set([...this.sessions.keys(), ...this.jobs.keys()]);
    return [...ids].filter((id) => {
      const status = this.deps.executions.getById(id)?.status as ExecutionStatus | undefined;
      return status !== undefined && consumesConcurrencySlot(status);
    }).length;
  }
  waitingCount(): number { return [...this.sessions.keys()].filter((id) => this.deps.executions.getById(id)?.status === 'waiting').length; }

  /** Listen to an execution's persisted events, for as long as it has any. @returns Unsubscribe. */
  subscribe(executionId: number, listener: Listener): () => void {
    const set = this.listeners.get(executionId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(executionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(executionId);
    };
  }

  /** Publish service-owned events through a live session when present; otherwise persist, then broadcast. */
  publish(executionId: number, event: UnnumberedConversationEvent): void {
    const session = this.sessions.get(executionId);
    if (session) { session.appendApplicationEvent(event); return; }
    const numbered = this.deps.events.append(executionId, { ...event, seq: this.deps.events.maxSeq(executionId) + 1 } as ConversationEvent);
    this.fanOut(executionId, numbered);
  }

  start(execution: ExecutionRow, task: TaskRow): TaskSession {
    const existing = this.sessions.get(execution.id);
    if (existing) return existing;
    this.assertCapacity();
    const session = new TaskSession({
      execution,
      task,
      provider: this.deps.provider,
      executions: this.deps.executions,
      events: this.deps.events,
      strategy: this.deps.strategy,
      paths: this.deps.paths,
      model: this.deps.model(),
      auth: this.deps.auth(),
      logger: this.deps.logger,
    });
    this.sessions.set(execution.id, session);
    session.subscribe((event) => this.fanOut(execution.id, event));
    void session
      .start()
      .then((row) => this.afterSession(row))
      .catch((cause) =>
        this.deps.logger.error(
          { cause, executionId: execution.id },
          'task session failed to settle',
        ),
      )
      .finally(() => this.sessions.delete(execution.id));
    return session;
  }

  /**
   * Track a phase job for cancellation and the concurrency cap. The caller has
   * already checked capacity where a person started the work.
   * @returns The job, removed from tracking once it settles.
   */
  track(executionId: number, job: PhaseJob): PhaseJob {
    this.jobs.set(executionId, job);
    void job.settled
      .catch((cause) => this.deps.logger.error({ cause, executionId }, 'phase job failed to settle'))
      .finally(() => { if (this.jobs.get(executionId) === job) this.jobs.delete(executionId); });
    return job;
  }

  get(executionId: number): TaskSession | undefined {
    return this.sessions.get(executionId);
  }

  /** Whether anything is in flight for this execution: a provider session or a phase job. */
  isLive(executionId: number): boolean {
    return this.sessions.has(executionId) || this.jobs.has(executionId);
  }

  /**
   * The one cancel path (FEAT-103, extended by FEAT-105/106/107): a provider
   * session, a phase job, or an execution parked at a gate.
   */
  async abort(executionId: number): Promise<ExecutionRow> {
    const row = this.deps.executions.getById(executionId);
    if (!row || isTerminal(row.status as ExecutionStatus))
      throw new ExecutionNotRunningError(executionId);
    const session = this.sessions.get(executionId);
    if (session) {
      this.deps.clarifications?.cancelForExecution(executionId);
      await session.abort();
      return session.settled;
    }
    const job = this.jobs.get(executionId);
    if (job) {
      job.abort();
      await job.settled.catch(() => undefined);
      return this.deps.executions.getById(executionId)!;
    }
    if (survivesRestart(row.status as ExecutionStatus)) return this.abortParked(row);
    throw new ExecutionInterruptedError(executionId);
  }

  /** A person changing their mind at a gate needs no process to stop: settle straight to `aborted`. */
  private abortParked(row: ExecutionRow): ExecutionRow {
    const settled = this.deps.executions.markSettled(row.id, { status: 'aborted' });
    this.publish(row.id, { type: 'state_changed', from: row.status as ExecutionStatus, to: 'aborted', at: new Date().toISOString() });
    this.deps.logger.info({ executionId: row.id, from: row.status }, 'parked execution aborted');
    return settled;
  }

  /**
   * Mark every execution a restart interrupted. `awaiting_approval` and
   * `awaiting_review` are skipped — they hold no in-memory state, and a
   * person's pending decision is not the server's to discard.
   */
  reconcileOnStartup(): number {
    const active = this.deps.executions.listActive();
    for (const row of active) this.interrupt(row);
    if (active.length)
      this.deps.logger.info(
        { count: active.length },
        'interrupted executions reconciled',
      );
    return active.length;
  }

  async drain(timeoutMs: number): Promise<void> {
    const sessions = [...this.sessions.entries()];
    const jobs = [...this.jobs.entries()];
    for (const [id] of sessions) this.deps.clarifications?.cancelForExecution(id);
    for (const [, job] of jobs) job.abort();
    await Promise.all(sessions.map(([, session]) => session.abort()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...sessions.map(([, session]) => session.settled), ...jobs.map(([, job]) => job.settled)]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    for (const id of new Set([...sessions.map(([id]) => id), ...jobs.map(([id]) => id)])) {
      const row = this.deps.executions.getById(id);
      if (row && !isTerminal(row.status as ExecutionStatus) && !survivesRestart(row.status as ExecutionStatus)) this.interrupt(row);
    }
  }

  /** Settle in-flight child rows first, then the execution, then say so in the transcript. */
  private interrupt(row: ExecutionRow): void {
    const next = this.deps.events.maxSeq(row.id) + 1;
    this.deps.onInterrupted?.(row.id);
    this.deps.executions.markInterrupted(row.id);
    this.deps.clarifications?.markInterrupted(row.id);
    const event: ConversationEvent = { seq: next, type: 'state_changed', from: row.status as ExecutionStatus, to: 'failed', at: new Date().toISOString() };
    this.deps.events.append(row.id, event);
    this.fanOut(row.id, event);
  }

  /** A session that settled in a hand-off status starts its next phase. */
  private afterSession(row: ExecutionRow): void {
    if (isTerminal(row.status as ExecutionStatus) || !this.deps.onHandOff) return;
    this.sessions.delete(row.id);
    this.deps.onHandOff(row);
  }

  private fanOut(executionId: number, event: ConversationEvent): void {
    for (const listener of [...(this.listeners.get(executionId) ?? [])]) {
      try {
        listener(event);
      } catch (cause) {
        this.deps.logger.warn({ cause, executionId, kind: event.type, seq: event.seq }, 'conversation subscriber threw');
      }
    }
  }
}
