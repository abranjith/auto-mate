import { and, desc, eq } from 'drizzle-orm';
import { RepositoryError, type RuntimeKind } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { runtimeEnvironment } from '../schema';

export type RuntimeEnvironmentRow = typeof runtimeEnvironment.$inferSelect;

export interface RuntimeScope {
  readonly kind: RuntimeKind;
  readonly specDigest: string;
  readonly lockDigest: string;
  readonly pythonVersion: string;
  readonly uvVersion: string;
  readonly platform: string;
  readonly arch: string;
}

export interface ReadyRuntime {
  readonly fingerprint: string;
  readonly packages: readonly { readonly name: string; readonly version: string }[];
  readonly launcherDigest: string | null;
  readonly durationMs: number;
}

/** Persistence boundary for a host's prepared Python environments. */
export class RuntimeEnvironmentRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Open a scope for preparation; an unchanged scope reuses its row. */
  open(scope: RuntimeScope): RuntimeEnvironmentRow {
    return this.write(() => {
      const existing = this.findByScope(scope);
      if (existing) return this.connection.db.update(runtimeEnvironment).set({ ...scope, status: 'preparing', fingerprint: null, packageJson: null, launcherDigest: null, failureReason: null, durationMs: null, preparedAt: null }).where(eq(runtimeEnvironment.id, existing.id)).returning().get()!;
      return this.connection.db.insert(runtimeEnvironment).values(scope).returning().get();
    });
  }

  /** Persist the exact resolved package set and fingerprint. */
  settleReady(id: number, result: ReadyRuntime): RuntimeEnvironmentRow {
    return this.write(() => this.connection.db.update(runtimeEnvironment).set({ status: 'ready', fingerprint: result.fingerprint, packageJson: JSON.stringify([...result.packages].sort((a, b) => a.name.localeCompare(b.name))), launcherDigest: result.launcherDigest, failureReason: null, durationMs: result.durationMs, preparedAt: this.now() }).where(eq(runtimeEnvironment.id, id)).returning().get()!);
  }

  /** Record a failed preparation without a misleading ready fingerprint. */
  settleFailed(id: number, reason: string): RuntimeEnvironmentRow {
    return this.write(() => this.connection.db.update(runtimeEnvironment).set({ status: 'failed', fingerprint: null, packageJson: null, launcherDigest: null, failureReason: reason, preparedAt: this.now() }).where(eq(runtimeEnvironment.id, id)).returning().get()!);
  }

  /** Record a cancelled preparation. */
  settleAborted(id: number): RuntimeEnvironmentRow {
    return this.write(() => this.connection.db.update(runtimeEnvironment).set({ status: 'aborted', fingerprint: null, packageJson: null, launcherDigest: null, failureReason: null, preparedAt: this.now() }).where(eq(runtimeEnvironment.id, id)).returning().get()!);
  }

  /** Read exactly one spec, lock, and host combination. */
  findByScope(scope: Pick<RuntimeScope, 'kind' | 'specDigest' | 'lockDigest' | 'platform' | 'arch'>): RuntimeEnvironmentRow | undefined {
    return this.read(() => this.connection.db.select().from(runtimeEnvironment).where(and(eq(runtimeEnvironment.kind, scope.kind), eq(runtimeEnvironment.specDigest, scope.specDigest), eq(runtimeEnvironment.lockDigest, scope.lockDigest), eq(runtimeEnvironment.platform, scope.platform), eq(runtimeEnvironment.arch, scope.arch))).get());
  }

  /** Explain an old run even after a newer lock was prepared. */
  findByFingerprint(fingerprint: string): RuntimeEnvironmentRow | undefined {
    return this.read(() => this.connection.db.select().from(runtimeEnvironment).where(eq(runtimeEnvironment.fingerprint, fingerprint)).get());
  }

  /** The most recently prepared ready row for one kind. */
  getReady(kind: RuntimeKind): RuntimeEnvironmentRow | undefined {
    return this.read(() => this.connection.db.select().from(runtimeEnvironment).where(and(eq(runtimeEnvironment.kind, kind), eq(runtimeEnvironment.status, 'ready'))).orderBy(desc(runtimeEnvironment.preparedAt)).get());
  }

  /** Most recent state, including a preparation in progress or a failure. */
  getLatest(kind: RuntimeKind): RuntimeEnvironmentRow | undefined {
    return this.read(() => this.connection.db.select().from(runtimeEnvironment).where(eq(runtimeEnvironment.kind, kind)).orderBy(desc(runtimeEnvironment.createdAt), desc(runtimeEnvironment.id)).get());
  }

  /** Settle crash-interrupted preparations so the next request retries. */
  failInterrupted(): number {
    return this.write(() => this.connection.db.update(runtimeEnvironment).set({ status: 'failed', failureReason: 'Preparation was interrupted by a server restart.', preparedAt: this.now() }).where(eq(runtimeEnvironment.status, 'preparing')).returning().all().length);
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { throw new RepositoryError('The runtime environment could not be read.', cause); }
  }

  private write<T>(action: () => T): T {
    try { return action(); } catch (cause) { throw new RepositoryError('The runtime environment could not be saved.', cause); }
  }
}
