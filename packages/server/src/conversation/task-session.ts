import {
  AutoMateError,
  type AgentAuthSelection,
  type AgentError,
  type AgentEvent,
  type AgentModelSelection,
  type AgentProvider,
  type AgentSession,
  type ConversationEvent,
  type ExecutionStatus,
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
import { TextCoalescer } from './text-coalescer';

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

  /** Ask the provider to abort at most once. */
  async abort(): Promise<void> {
    if (this.aborting) return;
    this.aborting = true;
    await this.agentSession?.abort();
  }

  private async run(): Promise<ExecutionRow> {
    let current: ExecutionStatus = this.deps.execution
      .status as ExecutionStatus;
    let unsubscribe: (() => void) | undefined;
    let failure: AgentError | undefined;
    try {
      this.deps.executions.markStarted(this.executionId);
      this.state(current, 'generating');
      current = 'generating';
      this.record({
        type: 'user_prompt',
        text: this.deps.task.description,
        at: this.clock().toISOString(),
      });
      const built = this.deps.strategy.buildRun(this.deps.task);
      const session = await this.deps.provider.open({
        executionId: String(this.executionId),
        sessionDir: this.deps.paths.sessionDirFor(String(this.executionId)),
        cwd: this.deps.paths.root,
        model: this.deps.model,
        auth: this.deps.auth,
        systemPrompt: built.systemPrompt ?? '',
      });
      this.agentSession = session;
      if (this.aborting) await session.abort();
      this.deps.executions.markSessionOpened(this.executionId, {
        sessionId: session.id,
        logPath: session.logPath,
        provider: this.deps.model.provider,
        model: this.deps.model.id,
      });
      unsubscribe = session.subscribe((event) => {
        if (event.type === 'failed') failure = event.error;
        this.consume(event);
      });
      const result = await session.run(built.prompt);
      this.coalescer.flush();
      const final = result.outcome;
      const settled = this.deps.executions.markSettled(this.executionId, {
        status: final,
        usage: result.usage,
        ...(failure && final === 'failed'
          ? { errorCode: failure.code, errorMessage: failure.message }
          : {}),
      });
      this.state(current, final);
      return settled;
    } catch (cause) {
      this.coalescer.flush();
      const code =
        cause instanceof AutoMateError
          ? cause.code
          : 'AGENT_SESSION_START_FAILED';
      const message =
        cause instanceof AutoMateError
          ? cause.message
          : 'The agent session could not complete this run.';
      const row = this.deps.executions.markSettled(this.executionId, {
        status: 'failed',
        errorCode: code,
        errorMessage: message,
      });
      this.record({
        type: 'failed',
        error: { code, message },
        at: this.clock().toISOString(),
      });
      this.state(current, 'failed');
      return row;
    } finally {
      unsubscribe?.();
      this.coalescer.dispose();
      await this.agentSession?.close();
    }
  }

  private consume(event: AgentEvent): void {
    if (event.type === 'assistant_text') {
      this.coalescer.push(event);
      return;
    }
    this.coalescer.flush();
    this.record(event);
  }
  private state(from: ExecutionStatus, to: ExecutionStatus): void {
    this.record({
      type: 'state_changed',
      from,
      to,
      at: this.clock().toISOString(),
    });
  }
  private record(event: AgentEvent | ApplicationEvent): void {
    const numbered = { ...event, seq: this.nextSeq } as ConversationEvent;
    this.nextSeq += 1;
    this.deps.events.append(this.executionId, numbered);
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
