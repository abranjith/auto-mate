import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../../db/client';
import { migrateDatabase } from '../../../db/migrate';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { DisclosureConsentRepository } from '../../../db/repositories/disclosure-consent-repository';
import { DisclosureTransmissionRepository } from '../../../db/repositories/disclosure-transmission-repository';
import { ClarificationRepository } from '../../../db/repositories/clarification-repository';

const roots: string[] = [];
const connections: DatabaseConnection[] = [];
afterEach(() => { connections.splice(0).forEach((item) => item.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function database() { const root = mkdtempSync(path.join(tmpdir(), 'automate-disclosure-')); roots.push(root); const paths = getAppPaths(root); ensureAppDirectories(paths); const connection = openDatabase(paths); connections.push(connection); migrateDatabase(connection); return connection; }

describe('disclosure persistence', () => {
  it('keeps grants idempotent and rejects contradictory transmissions', () => {
    const connection = database();
    const tasks = new TaskRepository(connection);
    const consents = new DisclosureConsentRepository(connection);
    const transmissions = new DisclosureTransmissionRepository(connection);
    const created = tasks.createWithExecution('summarize');
    const input = { taskId: created.task.id, uploadIds: [2, 1], payloadDigest: 'a'.repeat(64), payloadSnapshot: 'x'.repeat(64 * 1024), byteSize: 64 * 1024, provider: 'test', model: 'fake', scopeDiagnostics: true };
    const first = consents.grant(input);
    expect(consents.grant(input).id).toBe(first.id);
    expect(transmissions.record({ executionId: created.execution.id, consentId: first.id, kind: 'context', payloadDigest: first.payloadDigest, payloadSnapshot: null, byteSize: first.byteSize, summary: {}, provider: first.provider, model: first.model }).id).toBeGreaterThan(0);
    expect(() => transmissions.record({ executionId: created.execution.id, consentId: first.id, kind: 'context', payloadDigest: 'b'.repeat(64), payloadSnapshot: null, byteSize: 1, summary: {}, provider: first.provider, model: first.model })).toThrow(/digest/i);
    consents.revoke(first.id);
    expect(() => transmissions.record({ executionId: created.execution.id, consentId: first.id, kind: 'diagnostics', payloadDigest: 'c'.repeat(64), payloadSnapshot: 'safe', byteSize: 4, summary: {}, provider: first.provider, model: first.model })).toThrow(/revoked/i);
  });

  it('stores batches atomically, enforces non-cosmetic impact, and cascades', () => {
    const connection = database();
    const created = new TaskRepository(connection).createWithExecution('ask');
    const repository = new ClarificationRepository(connection);
    const batch = repository.open({ executionId: created.execution.id, source: 'agent', callId: 'call-1', questions: [{ impact: 'meaning', promptText: 'Which?', rationale: 'It changes meaning.', proposedDefault: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }] });
    expect(repository.countAgentQuestions(created.execution.id)).toBe(1);
    const answered = repository.answer(batch.id, [{ questionId: batch.questions[0]!.id, value: 'a' }]);
    expect(answered.status).toBe('answered');
    expect(answered.questions[0]?.answerSource).toBe('user');
    expect(() => repository.open({ executionId: created.execution.id, source: 'agent', questions: [{ impact: 'cosmetic' as 'meaning', promptText: 'Style?', rationale: 'None', proposedDefault: 'a' }] })).toThrow();
    connection.client.prepare('DELETE FROM task WHERE id = ?').run(created.task.id);
    expect((connection.client.prepare('SELECT count(*) count FROM clarification').get() as { count: number }).count).toBe(0);
  });
});
