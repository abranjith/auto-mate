import {
  ExecutionInterruptedError,
  ExecutionLimitReachedError,
  ExecutionNotRunningError,
  isTerminal,
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
}

/** Registry enforcing one live session per execution and the configured cap. */
export class TaskSessionRegistry {
  private readonly sessions = new Map<number, TaskSession>();
  constructor(private readonly deps: TaskSessionRegistryDependencies) {}

  assertCapacity(): void {
    if (this.activeCount() >= this.deps.maxConcurrentExecutions)
      throw new ExecutionLimitReachedError();
  }

  activeCount(): number { return [...this.sessions.keys()].filter((id) => this.deps.executions.getById(id)?.status !== 'waiting').length; }
  waitingCount(): number { return [...this.sessions.keys()].filter((id) => this.deps.executions.getById(id)?.status === 'waiting').length; }

  /** Publish service-owned events through a live session when present. */
  publish(executionId: number, event: UnnumberedConversationEvent): void {
    const session = this.sessions.get(executionId);
    if (session) { session.appendApplicationEvent(event); return; }
    this.deps.events.append(executionId, { ...event, seq: this.deps.events.maxSeq(executionId) + 1 } as ConversationEvent);
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
    void session
      .start()
      .catch((cause) =>
        this.deps.logger.error(
          { cause, executionId: execution.id },
          'task session failed to settle',
        ),
      )
      .finally(() => this.sessions.delete(execution.id));
    return session;
  }

  get(executionId: number): TaskSession | undefined {
    return this.sessions.get(executionId);
  }

  async abort(executionId: number): Promise<ExecutionRow> {
    const session = this.sessions.get(executionId);
    const row = this.deps.executions.getById(executionId);
    if (!row || isTerminal(row.status as ExecutionStatus))
      throw new ExecutionNotRunningError(executionId);
    if (!session) throw new ExecutionInterruptedError(executionId);
    this.deps.clarifications?.cancelForExecution(executionId);
    await session.abort();
    return session.settled;
  }

  reconcileOnStartup(): number {
    const active = this.deps.executions.listActive();
    for (const row of active) {
      const next = this.deps.events.maxSeq(row.id) + 1;
      this.deps.executions.markInterrupted(row.id);
      this.deps.clarifications?.markInterrupted(row.id);
      const event: ConversationEvent = {
        seq: next,
        type: 'state_changed',
        from: row.status as ExecutionStatus,
        to: 'failed',
        at: new Date().toISOString(),
      };
      this.deps.events.append(row.id, event);
    }
    if (active.length)
      this.deps.logger.info(
        { count: active.length },
        'interrupted executions reconciled',
      );
    return active.length;
  }

  async drain(timeoutMs: number): Promise<void> {
    const entries = [...this.sessions.entries()];
    for (const [id] of entries) this.deps.clarifications?.cancelForExecution(id);
    await Promise.all(entries.map(([, session]) => session.abort()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(entries.map(([, session]) => session.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    for (const [id] of entries) {
      const row = this.deps.executions.getById(id);
      if (row && !isTerminal(row.status as ExecutionStatus)) {
        const seq = this.deps.events.maxSeq(id) + 1;
        this.deps.executions.markInterrupted(id);
        this.deps.events.append(id, {
          seq,
          type: 'state_changed',
          from: row.status as ExecutionStatus,
          to: 'failed',
          at: new Date().toISOString(),
        });
      }
    }
  }
}
