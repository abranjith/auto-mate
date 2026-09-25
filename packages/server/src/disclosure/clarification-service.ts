import { ClarificationInvalidAnswerError, ClarificationLimitReachedError, ClarificationNotFoundError, ClarificationNotPendingError, MAX_ANSWER_CHARS, WaitingCapacityReachedError, type ConversationEvent, type FindingOption, type UnnumberedConversationEvent } from '@automate/core';
import type { ClarificationRepository, ClarificationWithQuestions, NewQuestion } from '../db/repositories/clarification-repository';
import type { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';

interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (reason: Error) => void }
export interface ClarificationServiceDependencies {
  readonly clarifications: ClarificationRepository;
  readonly executions: ExecutionRepository;
  readonly events: ConversationEventRepository;
  readonly maxAgentClarifications: number;
  readonly maxWaitingExecutions: number;
  readonly waitingCount: () => number;
  readonly publish?: (executionId: number, event: UnnumberedConversationEvent) => void;
}

/** Owns the in-memory wait while keeping every question and answer durable. */
export class ClarificationService {
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly deps: ClarificationServiceDependencies) {}

  /** Ask a bounded batch; decline with defaults when either server limit is exhausted. */
  async ask(executionId: number, callId: string, questions: readonly NewQuestion[]): Promise<unknown> {
    const count = this.deps.clarifications.countAgentQuestions(executionId);
    if (count + questions.length > this.deps.maxAgentClarifications) return this.decline(executionId, callId, questions, 'question_limit', new ClarificationLimitReachedError(this.deps.maxAgentClarifications).message);
    if (this.deps.waitingCount() >= this.deps.maxWaitingExecutions) return this.decline(executionId, callId, questions, 'waiting_capacity', new WaitingCapacityReachedError(this.deps.maxWaitingExecutions).message);
    const batch = this.deps.clarifications.open({ executionId, source: 'agent', callId, questions });
    this.deps.executions.transitionStatus(executionId, 'waiting');
    this.emit(executionId, { type: 'state_changed', from: 'generating', to: 'waiting', at: new Date().toISOString() });
    this.emit(executionId, { type: 'clarification_requested', clarificationId: batch.id, at: new Date().toISOString() });
    return new Promise((resolve, reject) => this.pending.set(batch.id, { resolve, reject }));
  }

  /** Validate, persist, publish, and resume a pending clarification. */
  answer(id: number, answers: readonly { questionId: number; value: string }[]): ClarificationWithQuestions {
    const batch = this.deps.clarifications.getById(id);
    if (!batch) throw new ClarificationNotFoundError(id);
    if (batch.status !== 'pending') throw new ClarificationNotPendingError(id);
    if (answers.length !== batch.questions.length || batch.questions.some((question) => !answers.some(({ questionId }) => questionId === question.id))) throw new ClarificationInvalidAnswerError('Answer every question in this clarification together.');
    for (const answer of answers) {
      const question = batch.questions.find(({ id: questionId }) => questionId === answer.questionId)!;
      if (answer.value.length > MAX_ANSWER_CHARS) throw new ClarificationInvalidAnswerError(`Answers must be ${MAX_ANSWER_CHARS} characters or fewer.`);
      const options = question.options ? JSON.parse(question.options) as FindingOption[] : null;
      if (options && !options.some(({ value }) => value === answer.value)) throw new ClarificationInvalidAnswerError(`Choose one of: ${options.map(({ value }) => value).join(', ')}.`);
    }
    const settled = this.deps.clarifications.answer(id, answers);
    this.emit(batch.executionId, { type: 'clarification_answered', clarificationId: id, at: new Date().toISOString() });
    this.deps.executions.transitionStatus(batch.executionId, 'generating');
    this.emit(batch.executionId, { type: 'state_changed', from: 'waiting', to: 'generating', at: new Date().toISOString() });
    this.pending.get(id)?.resolve({ answers: settled.questions.map((question) => ({ question: question.promptText, answer: question.answer })) });
    this.pending.delete(id);
    return settled;
  }

  /** Cancel an in-memory wait before aborting the provider session. */
  cancelForExecution(executionId: number): void {
    for (const batch of this.deps.clarifications.listByExecution(executionId).filter(({ status }) => status === 'pending')) {
      this.deps.clarifications.cancel(batch.id);
      this.pending.get(batch.id)?.reject(new Error('The clarification was cancelled.'));
      this.pending.delete(batch.id);
    }
  }

  markInterrupted(executionId: number): void {
    for (const batch of this.deps.clarifications.listByExecution(executionId).filter(({ status }) => status === 'pending')) {
      this.pending.get(batch.id)?.reject(new Error('The server restarted while waiting for an answer.'));
      this.pending.delete(batch.id);
    }
    this.deps.clarifications.markInterrupted(executionId);
  }

  private decline(executionId: number, callId: string, questions: readonly NewQuestion[], reason: 'question_limit' | 'waiting_capacity', message: string): unknown {
    const batch = this.deps.clarifications.open({ executionId, source: 'agent', callId, questions });
    this.deps.clarifications.decline(batch.id, reason);
    this.emit(executionId, { type: 'clarification_requested', clarificationId: batch.id, at: new Date().toISOString() });
    return { declined: true, reason, message, defaults: questions.map(({ promptText, proposedDefault }) => ({ question: promptText, answer: proposedDefault })) };
  }

  private emit(executionId: number, event: UnnumberedConversationEvent): void {
    if (this.deps.publish) { this.deps.publish(executionId, event); return; }
    this.deps.events.append(executionId, { ...event, seq: this.deps.events.maxSeq(executionId) + 1 } as ConversationEvent);
  }
}
