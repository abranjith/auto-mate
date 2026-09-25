import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeEnvironmentRepository, type RuntimeScope } from '../../../db/repositories/runtime-environment-repository';
import { createTempStore, type TempStore } from '../../support/ingestion-fixtures';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
const scope: RuntimeScope = { kind: 'script', specDigest: 's'.repeat(64), lockDigest: 'l'.repeat(64), pythonVersion: '3.14.6', uvVersion: 'uv 0.11.32', platform: 'win32', arch: 'x64' };

describe('RuntimeEnvironmentRepository', () => {
  it('reuses a scope, retains old lock rows, and reads ready state', () => {
    const store = createTempStore('automate-runtime-repo-');
    stores.push(store);
    const repo = new RuntimeEnvironmentRepository(store.connection);
    const first = repo.open(scope);
    expect(first).toMatchObject({ status: 'preparing', fingerprint: null });
    const ready = repo.settleReady(first.id, { fingerprint: 'f'.repeat(64), packages: [{ name: 'pytest', version: '9.1.1' }], launcherDigest: 'a'.repeat(64), durationMs: 42 });
    expect(ready.preparedAt).toBeInstanceOf(Date);
    expect(JSON.parse(ready.packageJson!)).toEqual([{ name: 'pytest', version: '9.1.1' }]);
    expect(repo.getReady('script')?.id).toBe(first.id);
    expect(repo.getReady('verify')).toBeUndefined();
    expect(repo.findByFingerprint('f'.repeat(64))?.id).toBe(first.id);
    expect(repo.open(scope).id).toBe(first.id);
    const second = repo.open({ ...scope, lockDigest: 'b'.repeat(64) });
    expect(second.id).not.toBe(first.id);
    expect(repo.findByScope(scope)?.id).toBe(first.id);
    expect((store.connection.client.prepare('SELECT count(*) AS n FROM runtime_environment').get() as { n: number }).n).toBe(2);
  });

  it('enforces readiness and settledness as database facts', () => {
    const store = createTempStore('automate-runtime-repo-');
    stores.push(store);
    const repo = new RuntimeEnvironmentRepository(store.connection);
    const row = repo.open(scope);
    expect(() => store.connection.client.prepare("UPDATE runtime_environment SET status='ready' WHERE id=?").run(row.id)).toThrow();
    expect(() => store.connection.client.prepare("UPDATE runtime_environment SET status='failed', prepared_at=1, fingerprint='f' WHERE id=?").run(row.id)).toThrow();
    repo.settleFailed(row.id, 'The lock was rejected.');
    expect(repo.findByScope(scope)).toMatchObject({ status: 'failed', failureReason: 'The lock was rejected.' });
  });
});
