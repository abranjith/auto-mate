import { afterEach, describe, expect, it } from 'vitest';
import { createTempStore, type TempStore } from '../../support/ingestion-fixtures';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { ClarificationRepository } from '../../../db/repositories/clarification-repository';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

describe('ClarificationRepository', () => {
  it('excludes follow-ups from the cap and carries readable answers in chain order', () => {
    const store = createTempStore('automate-prior-clarifications-'); stores.push(store);
    const task = new TaskRepository(store.connection).createWithExecution('Question task');
    const repo = new ClarificationRepository(store.connection);
    const base = { impact: 'meaning' as const, rationale: 'This changes the result.', proposedDefault: 'single_html' };
    const parent = repo.open({ executionId: task.execution.id, source: 'agent', status: 'answered', questions: [{ ...base, promptText: 'Which format?', options: [{ value: 'single_html', label: 'A single web page' }], answer: 'single_html', answerSource: 'user' }] }).questions[0]!;
    repo.open({ executionId: task.execution.id, source: 'agent', status: 'answered', questions: [{ ...base, promptText: 'Other question?', answer: 'another answer', answerSource: 'user' }] });
    const child = repo.open({ executionId: task.execution.id, source: 'agent', status: 'answered', questions: [{ ...base, promptText: 'What should it include?', answer: 'A short summary', answerSource: 'user', followUpOfQuestionId: parent.id }] }).questions[0]!;
    const grandchild = repo.open({ executionId: task.execution.id, source: 'agent', status: 'answered', questions: [{ ...base, promptText: 'How short?', answer: 'One page', answerSource: 'user', followUpOfQuestionId: child.id }] }).questions[0]!;
    expect(repo.countAgentQuestions(task.execution.id)).toBe(2);
    expect([parent.id, child.id, grandchild.id].map((id) => repo.followUpChainDepth(id))).toEqual([0, 1, 2]);
    expect(repo.findQuestion(parent.id)).toMatchObject({ executionId: task.execution.id, source: 'agent', status: 'answered' });
    expect(repo.hasFollowUp(parent.id)).toBe(true);
    store.connection.client.prepare("insert into execution (task_id, status) values (?, 'pending')").run(task.task.id);
    const nextId = (store.connection.client.prepare('select max(id) id from execution').get() as { id: number }).id;
    const lines = repo.priorAgentAnswersForTask(task.task.id, nextId);
    expect(lines[0]).toBe('Which format?: A single web page');
    expect(lines[1]).toBe('Follow-up — What should it include?: A short summary');
    expect(lines[2]).toBe('Follow-up — How short?: One page');
    expect(lines[3]).toBe('Other question?: another answer');
    expect(repo.priorAgentAnswersForTask(task.task.id, nextId, 25).join('').length).toBeLessThanOrEqual(25);
  });
});
