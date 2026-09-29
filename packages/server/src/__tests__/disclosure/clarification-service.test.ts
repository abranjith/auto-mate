import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { ClarificationRepository } from '../../db/repositories/clarification-repository';
import { ConversationEventRepository } from '../../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { ClarificationService } from '../../disclosure/clarification-service';

const roots: string[] = []; const connections: DatabaseConnection[] = [];
afterEach(() => { connections.splice(0).forEach((item) => item.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function setup(cap = 3, waiting = 5) { const root = mkdtempSync(path.join(tmpdir(), 'automate-clarify-')); roots.push(root); const paths = getAppPaths(root); ensureAppDirectories(paths); const connection = openDatabase(paths); connections.push(connection); migrateDatabase(connection); const tasks = new TaskRepository(connection); const executions = new ExecutionRepository(connection); const events = new ConversationEventRepository(connection); const clarifications = new ClarificationRepository(connection); const created = tasks.createWithExecution('ask'); executions.markStarted(created.execution.id); const service = new ClarificationService({ clarifications, executions, events, maxAgentClarifications: cap, maxWaitingExecutions: waiting, waitingCount: () => 0 }); return { tasks, executions, events, clarifications, created, service }; }
const question = { impact: 'meaning' as const, promptText: 'Which?', rationale: 'Meaning changes.', options: [{ value: 'a', label: 'A' }], proposedDefault: 'a' };

describe('ClarificationService', () => {
  it('parks, persists, answers, resumes, and records a gap-free event trail', async () => {
    const { executions, events, clarifications, created, service } = setup();
    const result = service.ask(created.execution.id, 'call-1', [question]);
    await Promise.resolve();
    const batch = clarifications.listByExecution(created.execution.id)[0]!;
    expect(executions.getById(created.execution.id)?.status).toBe('waiting');
    service.answer(batch.id, [{ questionId: batch.questions[0]!.id, value: 'a' }]);
    await expect(result).resolves.toEqual({ answers: [{ questionId: batch.questions[0]!.id, question: 'Which?', answer: 'a', answeredWith: 'choice', choiceLabel: 'A' }] });
    expect(executions.getById(created.execution.id)?.status).toBe('generating');
    expect(events.listAfter(created.execution.id, 0, 10).events.map(({ type }) => type)).toEqual(['state_changed', 'clarification_requested', 'clarification_answered', 'state_changed']);
  });

  it('persists a declined batch and returns defaults when the cap is exhausted', async () => {
    const { clarifications, created, service } = setup(0);
    await expect(service.ask(created.execution.id, 'call-cap', [question])).resolves.toMatchObject({ declined: true, reason: 'question_limit', defaults: [{ answer: 'a' }] });
    expect(clarifications.listByExecution(created.execution.id)[0]?.status).toBe('declined');
  });

  it('accepts trimmed own words and guides the agent without storing whitespace', async () => {
    const { clarifications, created, service } = setup();
    const result = service.ask(created.execution.id, 'typed', [question]);
    const batch = clarifications.listByExecution(created.execution.id)[0]!;
    service.answer(batch.id, [{ questionId: batch.questions[0]!.id, value: '  A different answer  ' }]);
    expect(clarifications.getById(batch.id)?.questions[0]?.answer).toBe('A different answer');
    await expect(result).resolves.toMatchObject({ answers: [{ answeredWith: 'own_words', answer: 'A different answer' }], guidance: expect.stringContaining('followUpOf') });
  });

  it('rejects whitespace and overlong answers while keeping the batch pending', async () => {
    const { clarifications, created, service } = setup();
    void service.ask(created.execution.id, 'invalid', [question]);
    const batch = clarifications.listByExecution(created.execution.id)[0]!;
    const reply = (value: string) => service.answer(batch.id, [{ questionId: batch.questions[0]!.id, value }]);
    expect(() => reply('   ')).toThrow('Type an answer or pick one of the choices.');
    expect(() => reply('x'.repeat(2001))).toThrow('2000 characters or fewer');
    expect(clarifications.getById(batch.id)?.status).toBe('pending');
  });

  it('accepts bounded follow-ups without spending the original-question cap', async () => {
    const { clarifications, created, service } = setup(1);
    const first = service.ask(created.execution.id, 'original', [question]);
    const original = clarifications.listByExecution(created.execution.id)[0]!;
    service.answer(original.id, [{ questionId: original.questions[0]!.id, value: 'my own words' }]);
    await first;
    const follow = service.ask(created.execution.id, 'follow', [{ ...question, promptText: 'What do you mean?', followUpOf: original.questions[0]!.id }]);
    const second = clarifications.listByExecution(created.execution.id)[1]!;
    expect(second.status).toBe('pending');
    expect(second.questions[0]?.followUpOfQuestionId).toBe(original.questions[0]!.id);
    expect(clarifications.countAgentQuestions(created.execution.id)).toBe(1);
    expect(clarifications.followUpChainDepth(second.questions[0]!.id)).toBe(1);
    service.answer(second.id, [{ questionId: second.questions[0]!.id, value: 'more detail' }]);
    await follow;
    const third = service.ask(created.execution.id, 'follow-2', [{ ...question, promptText: 'Another detail?', followUpOf: second.questions[0]!.id }]);
    const thirdBatch = clarifications.listByExecution(created.execution.id)[2]!;
    expect(thirdBatch.questions[0]?.followUpOfQuestionId).toBe(second.questions[0]!.id);
    expect(clarifications.followUpChainDepth(thirdBatch.questions[0]!.id)).toBe(2);
    service.answer(thirdBatch.id, [{ questionId: thirdBatch.questions[0]!.id, value: 'final detail' }]);
    await third;
    await expect(service.ask(created.execution.id, 'too-deep', [{ ...question, followUpOf: thirdBatch.questions[0]!.id }])).resolves.toMatchObject({ reason: 'question_limit' });
  });

  it('counts a duplicate follow-up as an ordinary question', async () => {
    const { clarifications, created, service } = setup(2);
    const first = service.ask(created.execution.id, 'original', [question]);
    const original = clarifications.listByExecution(created.execution.id)[0]!;
    service.answer(original.id, [{ questionId: original.questions[0]!.id, value: 'typed' }]);
    await first;
    const next = service.ask(created.execution.id, 'twice', [
      { ...question, promptText: 'First follow-up?', followUpOf: original.questions[0]!.id },
      { ...question, promptText: 'Second follow-up?', followUpOf: original.questions[0]!.id },
    ]);
    const batch = clarifications.listByExecution(created.execution.id)[1]!;
    expect(batch.questions.map(({ followUpOfQuestionId }) => followUpOfQuestionId)).toEqual([original.questions[0]!.id, null]);
    expect(clarifications.countAgentQuestions(created.execution.id)).toBe(2);
    service.answer(batch.id, batch.questions.map(({ id }) => ({ questionId: id, value: 'a' })));
    await next;
  });

  it('counts pending, choice, and foreign parents as ordinary questions', async () => {
    const f = setup(1);
    const pending = f.clarifications.open({ executionId: f.created.execution.id, source: 'agent', questions: [question] });
    await expect(f.service.ask(f.created.execution.id, 'pending-parent', [{ ...question, followUpOf: pending.questions[0]!.id }])).resolves.toMatchObject({ reason: 'question_limit' });
    const choice = setup(1);
    const answered = choice.clarifications.open({ executionId: choice.created.execution.id, source: 'agent', status: 'answered', questions: [{ ...question, answer: 'a', answerSource: 'user' }] });
    await expect(choice.service.ask(choice.created.execution.id, 'choice-parent', [{ ...question, followUpOf: answered.questions[0]!.id }])).resolves.toMatchObject({ reason: 'question_limit' });
    const foreign = setup(0);
    const otherExecution = foreign.tasks.createWithExecution('another').execution;
    const other = foreign.clarifications.open({ executionId: otherExecution.id, source: 'agent', status: 'answered', questions: [{ ...question, answer: 'typed', answerSource: 'user' }] });
    await expect(foreign.service.ask(foreign.created.execution.id, 'foreign-parent', [{ ...question, followUpOf: other.questions[0]!.id }])).resolves.toMatchObject({ reason: 'question_limit' });
  });

  it('declines a follow-up when waiting capacity is spent', async () => {
    const { clarifications, created, service } = setup(3, 0);
    const parent = clarifications.open({ executionId: created.execution.id, source: 'agent', status: 'answered', questions: [{ ...question, answer: 'typed', answerSource: 'user' }] });
    await expect(service.ask(created.execution.id, 'at-capacity', [{ ...question, followUpOf: parent.questions[0]!.id }])).resolves.toMatchObject({ reason: 'waiting_capacity' });
  });
});
