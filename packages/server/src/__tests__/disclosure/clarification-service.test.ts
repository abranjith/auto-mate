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
function setup(cap = 3, waiting = 5) { const root = mkdtempSync(path.join(tmpdir(), 'automate-clarify-')); roots.push(root); const paths = getAppPaths(root); ensureAppDirectories(paths); const connection = openDatabase(paths); connections.push(connection); migrateDatabase(connection); const tasks = new TaskRepository(connection); const executions = new ExecutionRepository(connection); const events = new ConversationEventRepository(connection); const clarifications = new ClarificationRepository(connection); const created = tasks.createWithExecution('ask'); executions.markStarted(created.execution.id); const service = new ClarificationService({ clarifications, executions, events, maxAgentClarifications: cap, maxWaitingExecutions: waiting, waitingCount: () => 0 }); return { executions, events, clarifications, created, service }; }
const question = { impact: 'meaning' as const, promptText: 'Which?', rationale: 'Meaning changes.', options: [{ value: 'a', label: 'A' }], proposedDefault: 'a' };

describe('ClarificationService', () => {
  it('parks, persists, answers, resumes, and records a gap-free event trail', async () => {
    const { executions, events, clarifications, created, service } = setup();
    const result = service.ask(created.execution.id, 'call-1', [question]);
    await Promise.resolve();
    const batch = clarifications.listByExecution(created.execution.id)[0]!;
    expect(executions.getById(created.execution.id)?.status).toBe('waiting');
    service.answer(batch.id, [{ questionId: batch.questions[0]!.id, value: 'a' }]);
    await expect(result).resolves.toEqual({ answers: [{ question: 'Which?', answer: 'a' }] });
    expect(executions.getById(created.execution.id)?.status).toBe('generating');
    expect(events.listAfter(created.execution.id, 0, 10).events.map(({ type }) => type)).toEqual(['state_changed', 'clarification_requested', 'clarification_answered', 'state_changed']);
  });

  it('persists a declined batch and returns defaults when the cap is exhausted', async () => {
    const { clarifications, created, service } = setup(0);
    await expect(service.ask(created.execution.id, 'call-cap', [question])).resolves.toMatchObject({ declined: true, reason: 'question_limit', defaults: [{ answer: 'a' }] });
    expect(clarifications.listByExecution(created.execution.id)[0]?.status).toBe('declined');
  });
});
