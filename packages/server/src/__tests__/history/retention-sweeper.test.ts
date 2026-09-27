import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';
import { TaskRepository } from '../../db/repositories/task-repository';
import { HistoryRepository } from '../../db/repositories/history-repository';
import { DisclosureConsentRepository } from '../../db/repositories/disclosure-consent-repository';
import { RetentionSweeper } from '../../history/retention-sweeper';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
describe('retention orphan sweep', () => {
  it('removes numeric orphans, preserves live trees and nonnumeric sessions, and expires unattached consents', async () => {
    const store = createTempStore('automate-history-sweep-'); stores.push(store);
    const task = new TaskRepository(store.connection).createWithExecution('Keep this task');
    for (const root of [store.paths.runsDir, store.paths.scriptsDir, store.paths.agentSessionsDir]) {
      mkdirSync(path.join(root, '999')); writeFileSync(path.join(root, '999', 'sentinel'), 'orphan');
      mkdirSync(path.join(root, String(task.execution.id)));
    }
    mkdirSync(path.join(store.paths.agentSessionsDir, 'agent-smoke'));
    mkdirSync(path.join(store.paths.agentSessionsDir, 'connection-test-123'));
    writeFileSync(path.join(store.paths.runsDir, '998'), 'a file, not a directory');
    const consents = new DisclosureConsentRepository(store.connection);
    const grant = (taskId: number | null, digest: string) => consents.grant({ taskId, uploadIds: [], payloadDigest: digest, payloadSnapshot: '{}', byteSize: 2, provider: 'fake', model: 'fake', scopeDiagnostics: false });
    const old = grant(null, 'a'.repeat(64)); grant(null, 'b'.repeat(64)); const attached = grant(task.task.id, 'c'.repeat(64));
    store.connection.client.prepare('update disclosure_consent set granted_at = ? where id in (?, ?)').run(1, old.id, attached.id);
    const sweeper = new RetentionSweeper({ paths: store.paths, history: new HistoryRepository(store.connection), consents, ttlHours: 24, logger: pino({ level: 'silent' }), now: () => new Date('2026-09-26T00:00:00Z') });
    const [first, same] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(first).toEqual(same);
    expect(first).toEqual({ treesRemoved: 4, treesPending: 0, consentsRemoved: 1 });
    expect(existsSync(path.join(store.paths.runsDir, '998'))).toBe(false);
    expect(await sweeper.sweep()).toEqual({ treesRemoved: 0, treesPending: 0, consentsRemoved: 0 });
    for (const root of [store.paths.runsDir, store.paths.scriptsDir, store.paths.agentSessionsDir]) { expect(existsSync(path.join(root, '999'))).toBe(false); expect(existsSync(path.join(root, String(task.execution.id)))).toBe(true); }
    expect(existsSync(path.join(store.paths.agentSessionsDir, 'agent-smoke'))).toBe(true);
    expect(existsSync(path.join(store.paths.agentSessionsDir, 'connection-test-123'))).toBe(true);
    expect(consents.getById(old.id)).toBeUndefined(); expect(consents.getById(attached.id)).toBeDefined();
    sweeper.stop();
  });
});
