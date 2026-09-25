import { and, desc, eq, isNull } from 'drizzle-orm';
import { RepositoryError } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { disclosureConsent } from '../schema';

export type DisclosureConsentRow = typeof disclosureConsent.$inferSelect;
export interface GrantConsentInput {
  readonly taskId?: number | null;
  readonly uploadIds: readonly number[];
  readonly payloadDigest: string;
  readonly payloadSnapshot: string;
  readonly byteSize: number;
  readonly provider: string;
  readonly model: string;
  readonly scopeDiagnostics: boolean;
}

/** Exclusive persistence boundary for exact disclosure approvals. */
export class DisclosureConsentRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Persist an immutable approval, idempotently. */
  grant(input: GrantConsentInput): DisclosureConsentRow {
    const existing = this.findEquivalent(input);
    if (existing) return existing;
    try {
      return this.connection.db.insert(disclosureConsent).values({
        taskId: input.taskId ?? null,
        uploadIds: JSON.stringify([...input.uploadIds].sort((a, b) => a - b)),
        payloadDigest: input.payloadDigest,
        payloadSnapshot: input.payloadSnapshot,
        byteSize: input.byteSize,
        provider: input.provider,
        model: input.model,
        scopeContext: true,
        scopeDiagnostics: input.scopeDiagnostics,
        grantedAt: this.now(),
        createdAt: this.now(),
      }).returning().get();
    } catch (cause) { throw new RepositoryError('The disclosure approval could not be saved.', cause); }
  }

  /** Find the newest live approval attached to a task. */
  findLiveForTask(taskId: number): DisclosureConsentRow | undefined {
    try { return this.connection.db.select().from(disclosureConsent).where(and(eq(disclosureConsent.taskId, taskId), isNull(disclosureConsent.revokedAt))).orderBy(desc(disclosureConsent.grantedAt), desc(disclosureConsent.id)).get(); }
    catch (cause) { throw new RepositoryError('The disclosure approval could not be read.', cause); }
  }

  /** Read one live approval by digest and recipient, including pre-task approvals. */
  findByDigest(payloadDigest: string, provider?: string, model?: string): DisclosureConsentRow | undefined {
    try {
      const conditions = [eq(disclosureConsent.payloadDigest, payloadDigest), isNull(disclosureConsent.revokedAt)];
      if (provider) conditions.push(eq(disclosureConsent.provider, provider));
      if (model) conditions.push(eq(disclosureConsent.model, model));
      return this.connection.db.select().from(disclosureConsent).where(and(...conditions)).orderBy(desc(disclosureConsent.id)).get();
    } catch (cause) { throw new RepositoryError('The disclosure approval could not be read.', cause); }
  }

  /** Read one approval by id. */
  getById(id: number): DisclosureConsentRow | undefined {
    try { return this.connection.db.select().from(disclosureConsent).where(eq(disclosureConsent.id, id)).get(); }
    catch (cause) { throw new RepositoryError('The disclosure approval could not be read.', cause); }
  }

  /** Bind a pre-task approval to the task created from it. */
  attachToTask(id: number, taskId: number): DisclosureConsentRow {
    try {
      const row = this.connection.db.update(disclosureConsent).set({ taskId }).where(and(eq(disclosureConsent.id, id), isNull(disclosureConsent.taskId), isNull(disclosureConsent.revokedAt))).returning().get();
      if (!row) throw new RepositoryError('The disclosure approval is no longer available.');
      return row;
    } catch (cause) { if (cause instanceof RepositoryError) throw cause; throw new RepositoryError('The disclosure approval could not be attached.', cause); }
  }

  /** Revoke an approval without deleting its audit history. */
  revoke(id: number): DisclosureConsentRow | undefined {
    try { return this.connection.db.update(disclosureConsent).set({ revokedAt: this.now() }).where(eq(disclosureConsent.id, id)).returning().get(); }
    catch (cause) { throw new RepositoryError('The disclosure approval could not be revoked.', cause); }
  }

  private findEquivalent(input: GrantConsentInput): DisclosureConsentRow | undefined {
    const row = this.findByDigest(input.payloadDigest, input.provider, input.model);
    if (!row || row.taskId !== (input.taskId ?? null)) return undefined;
    if (row.uploadIds !== JSON.stringify([...input.uploadIds].sort((a, b) => a - b))) return undefined;
    if (row.scopeDiagnostics !== input.scopeDiagnostics || row.payloadSnapshot !== input.payloadSnapshot) return undefined;
    return row;
  }
}
