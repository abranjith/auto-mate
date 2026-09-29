import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { answerText, ClarificationNotFoundError, ClarificationNotPendingError, MAX_FOLLOW_UP_DEPTH, RepositoryError, type FindingOption } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { clarification, clarificationQuestion, execution } from '../schema';

export type ClarificationRow = typeof clarification.$inferSelect;
export type ClarificationQuestionRow = typeof clarificationQuestion.$inferSelect;
export interface ClarificationWithQuestions extends ClarificationRow { readonly questions: readonly ClarificationQuestionRow[] }
export interface NewQuestion { readonly findingKey?: string | null; readonly impact: 'data_loss' | 'meaning'; readonly promptText: string; readonly rationale: string; readonly options?: readonly FindingOption[] | null; readonly proposedDefault: string; readonly answer?: string | null; readonly answerSource?: 'user' | 'default' | 'seeded' | null; readonly followUpOf?: number; readonly followUpOfQuestionId?: number | null }
export type ClarificationTransaction = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];

/** Exclusive persistence boundary for clarification batches and answers. */
export class ClarificationRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Insert a whole batch atomically. */
  open(input: { executionId: number; source: 'preflight' | 'agent'; callId?: string | null; status?: 'pending' | 'answered'; questions: readonly NewQuestion[] }, transaction?: ClarificationTransaction): ClarificationWithQuestions {
    try {
      const insert = (tx: ClarificationTransaction) => {
        const settled = input.status === 'answered' ? this.now() : null;
        const batch = tx.insert(clarification).values({ executionId: input.executionId, source: input.source, callId: input.callId ?? null, status: input.status ?? 'pending', askedAt: this.now(), settledAt: settled, createdAt: this.now() }).returning().get();
        const questions = input.questions.map((question, position) => tx.insert(clarificationQuestion).values({ clarificationId: batch.id, position, findingKey: question.findingKey ?? null, impact: question.impact, promptText: question.promptText, rationale: question.rationale, options: question.options ? JSON.stringify(question.options) : null, proposedDefault: question.proposedDefault, answer: question.answer ?? null, answerSource: question.answerSource ?? null, followUpOfQuestionId: question.followUpOfQuestionId ?? null, answeredAt: question.answer ? this.now() : null, createdAt: this.now() }).returning().get());
        return { ...batch, questions };
      };
      return transaction ? insert(transaction) : this.connection.db.transaction(insert);
    } catch (cause) { throw new RepositoryError('The clarification could not be opened.', cause); }
  }

  /** Read one batch with ordered questions. */
  getById(id: number): ClarificationWithQuestions | undefined {
    try { const batch = this.connection.db.select().from(clarification).where(eq(clarification.id, id)).get(); return batch ? { ...batch, questions: this.questionsFor([id]) } : undefined; }
    catch (cause) { throw new RepositoryError('The clarification could not be read.', cause); }
  }

  /** List all batches and questions for one execution. */
  listByExecution(executionId: number): ClarificationWithQuestions[] {
    try { const batches = this.connection.db.select().from(clarification).where(eq(clarification.executionId, executionId)).orderBy(asc(clarification.askedAt), asc(clarification.id)).all(); const questions = this.questionsFor(batches.map(({ id }) => id)); return batches.map((batch) => ({ ...batch, questions: questions.filter((question) => question.clarificationId === batch.id) })); }
    catch (cause) { throw new RepositoryError('Clarifications could not be read.', cause); }
  }

  /** Count persisted agent questions across all batches for an execution. */
  countAgentQuestions(executionId: number): number { return this.listByExecution(executionId).filter(({ source }) => source === 'agent').reduce((count, batch) => count + batch.questions.filter(({ followUpOfQuestionId }) => followUpOfQuestionId === null).length, 0); }

  /** Find a question together with the batch that owns its execution and state. */
  findQuestion(id: number): (ClarificationQuestionRow & { executionId: number; source: 'agent' | 'preflight'; status: ClarificationRow['status'] }) | undefined {
    const row = this.connection.db.select({ question: clarificationQuestion, batch: clarification }).from(clarificationQuestion).innerJoin(clarification, eq(clarificationQuestion.clarificationId, clarification.id)).where(eq(clarificationQuestion.id, id)).get();
    return row ? { ...row.question, executionId: row.batch.executionId, source: row.batch.source as 'agent' | 'preflight', status: row.batch.status as ClarificationRow['status'] } : undefined;
  }

  /** Walk the bounded parent chain; a broken or cyclic chain cannot be accepted. */
  followUpChainDepth(id: number): number {
    let depth = 0; let current = this.findQuestion(id);
    while (current?.followUpOfQuestionId !== null && current?.followUpOfQuestionId !== undefined && depth <= MAX_FOLLOW_UP_DEPTH) { depth++; current = this.findQuestion(current.followUpOfQuestionId); }
    return current ? depth : MAX_FOLLOW_UP_DEPTH + 1;
  }

  /** Whether a parent already has its one permitted follow-up. */
  hasFollowUp(id: number): boolean { return this.connection.db.select({ id: clarificationQuestion.id }).from(clarificationQuestion).where(eq(clarificationQuestion.followUpOfQuestionId, id)).get() !== undefined; }

  /** Atomically answer every question and settle the batch. */
  answer(id: number, answers: readonly { questionId: number; value: string; source?: 'user' | 'default' | 'seeded' }[]): ClarificationWithQuestions {
    try {
      return this.connection.db.transaction((tx) => {
        const batch = tx.select().from(clarification).where(eq(clarification.id, id)).get();
        if (!batch) throw new ClarificationNotFoundError(id);
        if (batch.status !== 'pending') throw new ClarificationNotPendingError(id);
        const rows = tx.select().from(clarificationQuestion).where(eq(clarificationQuestion.clarificationId, id)).all();
        if (answers.length !== rows.length || rows.some((row) => !answers.some((answer) => answer.questionId === row.id))) throw new RepositoryError('Every clarification question must be answered together.');
        for (const answer of answers) tx.update(clarificationQuestion).set({ answer: answer.value, answerSource: answer.source ?? 'user', answeredAt: this.now() }).where(and(eq(clarificationQuestion.id, answer.questionId), eq(clarificationQuestion.clarificationId, id))).run();
        const settled = tx.update(clarification).set({ status: 'answered', settledAt: this.now() }).where(and(eq(clarification.id, id), eq(clarification.status, 'pending'))).returning().get();
        if (!settled) throw new ClarificationNotPendingError(id);
        return { ...settled, questions: tx.select().from(clarificationQuestion).where(eq(clarificationQuestion.clarificationId, id)).orderBy(asc(clarificationQuestion.position)).all() };
      });
    } catch (cause) { if (cause instanceof ClarificationNotFoundError || cause instanceof ClarificationNotPendingError || cause instanceof RepositoryError) throw cause; throw new RepositoryError('The clarification answer could not be saved.', cause); }
  }

  decline(id: number, reason: 'question_limit' | 'waiting_capacity'): void { this.settle(id, 'declined', reason); }
  cancel(id: number): void { this.settle(id, 'cancelled', null); }
  markInterrupted(executionId: number): void {
    try { this.connection.db.update(clarification).set({ status: 'interrupted', settledAt: this.now() }).where(and(eq(clarification.executionId, executionId), eq(clarification.status, 'pending'))).run(); }
    catch (cause) { throw new RepositoryError('Pending clarifications could not be interrupted.', cause); }
  }

  /** Most recent settled answer for each pre-flight finding on a task. */
  priorAnswersForTask(taskId: number): ReadonlyMap<string, string> {
    try {
      const executions = this.connection.db.select({ id: execution.id }).from(execution).where(eq(execution.taskId, taskId)).orderBy(desc(execution.id)).all();
      if (executions.length === 0) return new Map();
      const batches = this.connection.db.select().from(clarification).where(and(inArray(clarification.executionId, executions.map(({ id }) => id)), eq(clarification.status, 'answered'))).orderBy(desc(clarification.id)).all();
      const answers = new Map<string, string>();
      for (const question of this.questionsFor(batches.map(({ id }) => id)).sort((a, b) => b.id - a.id)) if (question.findingKey && question.answer && !answers.has(question.findingKey)) answers.set(question.findingKey, question.answer);
      return answers;
    } catch (cause) { throw new RepositoryError('Prior clarification answers could not be read.', cause); }
  }

  /** Bounded application text from answered agent questions on earlier executions. */
  priorAgentAnswersForTask(taskId: number, beforeExecutionId: number, maxChars = 4_000): readonly string[] {
    try {
      const executions = this.connection.db.select({ id: execution.id }).from(execution)
        .where(eq(execution.taskId, taskId)).all().filter(({ id }) => id < beforeExecutionId);
      if (executions.length === 0) return [];
      const batches = this.connection.db.select().from(clarification)
        .where(and(inArray(clarification.executionId, executions.map(({ id }) => id)), eq(clarification.source, 'agent'), eq(clarification.status, 'answered')))
        .orderBy(desc(clarification.id)).all();
      const answers: string[] = [];
      const seen = new Set<string>();
      let remaining = maxChars;
      const selected: ClarificationQuestionRow[] = [];
      for (const question of this.questionsFor(batches.map(({ id }) => id)).sort((a, b) => b.id - a.id)) {
        if (!question.answer || seen.has(question.promptText) || remaining <= 0) continue;
        seen.add(question.promptText);
        selected.push(question);
      }
      const byId = new Map(selected.map((question) => [question.id, question]));
      const children = new Map<number, ClarificationQuestionRow[]>();
      for (const question of selected) if (question.followUpOfQuestionId && byId.has(question.followUpOfQuestionId)) children.set(question.followUpOfQuestionId, [...(children.get(question.followUpOfQuestionId) ?? []), question]);
      const ordered: ClarificationQuestionRow[] = [];
      const visit = (question: ClarificationQuestionRow): void => { if (ordered.includes(question)) return; ordered.push(question); for (const child of children.get(question.id) ?? []) visit(child); };
      selected.reverse().filter((question) => !question.followUpOfQuestionId || !byId.has(question.followUpOfQuestionId)).forEach(visit);
      for (const question of ordered) {
        if (remaining <= 0) break;
        const options = question.options ? JSON.parse(question.options) as FindingOption[] : null;
        const line = `${question.followUpOfQuestionId ? 'Follow-up — ' : ''}${question.promptText}: ${answerText({ answer: question.answer, answerSource: question.answerSource as 'user' | 'default' | 'seeded' | null, options })}`.slice(0, remaining);
        answers.push(line); remaining -= line.length;
      }
      return answers;
    } catch (cause) { throw new RepositoryError('Prior agent clarification answers could not be read.', cause); }
  }

  private questionsFor(ids: readonly number[]): ClarificationQuestionRow[] { return ids.length === 0 ? [] : this.connection.db.select().from(clarificationQuestion).where(inArray(clarificationQuestion.clarificationId, [...ids])).orderBy(asc(clarificationQuestion.clarificationId), asc(clarificationQuestion.position)).all(); }
  private settle(id: number, status: 'declined' | 'cancelled', declineReason: 'question_limit' | 'waiting_capacity' | null): void { try { this.connection.db.update(clarification).set({ status, declineReason, settledAt: this.now() }).where(eq(clarification.id, id)).run(); } catch (cause) { throw new RepositoryError('The clarification could not be settled.', cause); } }
}
