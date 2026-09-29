import { answerKind, ClarificationInvalidAnswerError, ClarificationLimitReachedError, ClarificationNotFoundError, ClarificationNotPendingError, FOLLOW_UP_GUIDANCE, MAX_ANSWER_CHARS, MAX_FOLLOW_UP_DEPTH, WaitingCapacityReachedError, type ConversationEvent, type FindingOption, type UnnumberedConversationEvent } from '@automate/core';
import type { ClarificationRepository, ClarificationWithQuestions, NewQuestion } from '../db/repositories/clarification-repository';
import type { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { Logger } from 'pino';

interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (reason: Error) => void }
export interface ClarificationServiceDependencies {
  readonly clarifications: ClarificationRepository;
  readonly executions: ExecutionRepository;
  readonly events: ConversationEventRepository;
  readonly maxAgentClarifications: number;
  readonly maxWaitingExecutions: number;
  readonly waitingCount: () => number;
  readonly publish?: (executionId: number, event: UnnumberedConversationEvent) => void;
  readonly logger?: Pick<Logger, 'info'>;
}

/** Owns the in-memory wait while keeping every question and answer durable. */
export class ClarificationService {
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly deps: ClarificationServiceDependencies) {}

  /** Ask a bounded batch; decline with defaults when either server limit is exhausted. */
  async ask(executionId: number, callId: string, questions: readonly NewQuestion[]): Promise<unknown> {
    const acceptedParents = new Set<number>();
    const resolved = questions.map((question) => {
      const parentId = question.followUpOf;
      if (!parentId || acceptedParents.has(parentId)) return { ...question, followUpOfQuestionId: null };
      const parent = this.deps.clarifications.findQuestion(parentId);
      const options = parent?.options ? JSON.parse(parent.options) as FindingOption[] : null;
      const accepted = parent?.executionId === executionId && parent.source === 'agent' && parent.status === 'answered' && answerKind({ answer: parent.answer, answerSource: parent.answerSource as 'user' | 'default' | 'seeded' | null, options }) === 'own_words' && !this.deps.clarifications.hasFollowUp(parentId) && this.deps.clarifications.followUpChainDepth(parentId) < MAX_FOLLOW_UP_DEPTH;
      if (accepted) acceptedParents.add(parentId);
      return { ...question, followUpOfQuestionId: accepted ? parentId : null };
    });
    const count = this.deps.clarifications.countAgentQuestions(executionId);
    if (count + resolved.filter(({ followUpOfQuestionId }) => followUpOfQuestionId === null).length > this.deps.maxAgentClarifications) return this.decline(executionId, callId, resolved.map((question) => ({ ...question, followUpOfQuestionId: null })), 'question_limit', new ClarificationLimitReachedError(this.deps.maxAgentClarifications).message);
    if (this.deps.waitingCount() >= this.deps.maxWaitingExecutions) return this.decline(executionId, callId, resolved.map((question) => ({ ...question, followUpOfQuestionId: null })), 'waiting_capacity', new WaitingCapacityReachedError(this.deps.maxWaitingExecutions).message);
    const batch = this.deps.clarifications.open({ executionId, source: 'agent', callId, questions: resolved });
    this.deps.logger?.info({ executionId, clarificationId: batch.id, questionCount: batch.questions.length, acceptedFollowUpCount: acceptedParents.size }, 'Clarification asked');
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
    const trimmed = answers.map((answer) => ({ ...answer, value: answer.value.trim() }));
    for (const answer of trimmed) {
      if (!answer.value) throw new ClarificationInvalidAnswerError('Type an answer or pick one of the choices.');
      if (answer.value.length > MAX_ANSWER_CHARS) throw new ClarificationInvalidAnswerError(`Answers must be ${MAX_ANSWER_CHARS} characters or fewer.`);
    }
    const settled = this.deps.clarifications.answer(id, trimmed);
    const kinds = settled.questions.map((question) => answerKind({ answer: question.answer, answerSource: question.answerSource as 'user' | 'default' | 'seeded' | null, options: question.options ? JSON.parse(question.options) as FindingOption[] : null }));
    this.deps.logger?.info({ executionId: batch.executionId, clarificationId: id, choiceCount: kinds.filter((kind) => kind === 'choice').length, ownWordsCount: kinds.filter((kind) => kind === 'own_words').length }, 'Clarification answered');
    this.emit(batch.executionId, { type: 'clarification_answered', clarificationId: id, at: new Date().toISOString() });
    this.deps.executions.transitionStatus(batch.executionId, 'generating');
    this.emit(batch.executionId, { type: 'state_changed', from: 'waiting', to: 'generating', at: new Date().toISOString() });
    const resultAnswers = settled.questions.map((question) => {
      const options = question.options ? JSON.parse(question.options) as FindingOption[] : null;
      const kind = answerKind({ answer: question.answer, answerSource: question.answerSource as 'user' | 'default' | 'seeded' | null, options });
      return { questionId: question.id, question: question.promptText, answer: question.answer, answeredWith: kind, ...(kind === 'choice' ? { choiceLabel: options?.find(({ value }) => value === question.answer)?.label } : {}) };
    });
    this.pending.get(id)?.resolve({ answers: resultAnswers, ...(resultAnswers.some(({ answeredWith }) => answeredWith === 'own_words') ? { guidance: FOLLOW_UP_GUIDANCE } : {}) });
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
