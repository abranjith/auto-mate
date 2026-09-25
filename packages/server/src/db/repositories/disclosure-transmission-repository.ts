import { asc, eq } from 'drizzle-orm';
import { RepositoryError } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { disclosureConsent, disclosureTransmission } from '../schema';

export type DisclosureTransmissionRow = typeof disclosureTransmission.$inferSelect;
export interface RecordTransmissionInput {
  readonly executionId: number;
  readonly consentId: number;
  readonly kind: 'context' | 'diagnostics';
  readonly payloadDigest: string;
  readonly payloadSnapshot: string | null;
  readonly byteSize: number;
  readonly summary: unknown;
  readonly provider: string;
  readonly model: string;
}

/** Persistence boundary that independently enforces consent/transmission equality. */
export class DisclosureTransmissionRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Record intent to transmit after checking the referenced approval. */
  record(input: RecordTransmissionInput): DisclosureTransmissionRow {
    try {
      return this.connection.db.transaction((tx) => {
        const consent = tx.select().from(disclosureConsent).where(eq(disclosureConsent.id, input.consentId)).get();
        if (!consent || consent.revokedAt) throw new RepositoryError('A revoked or missing consent cannot authorize a transmission.');
        if (consent.provider !== input.provider || consent.model !== input.model) throw new RepositoryError('The transmission recipient does not match its consent.');
        if (input.kind === 'context' && consent.payloadDigest !== input.payloadDigest) throw new RepositoryError('The transmission digest does not match its consent.');
        return tx.insert(disclosureTransmission).values({ ...input, summary: JSON.stringify(input.summary), at: this.now() }).returning().get();
      });
    } catch (cause) { if (cause instanceof RepositoryError) throw cause; throw new RepositoryError('The disclosure transmission could not be recorded.', cause); }
  }

  /** List receipts in send order. */
  listByExecution(executionId: number): DisclosureTransmissionRow[] {
    try { return this.connection.db.select().from(disclosureTransmission).where(eq(disclosureTransmission.executionId, executionId)).orderBy(asc(disclosureTransmission.at), asc(disclosureTransmission.id)).all(); }
    catch (cause) { throw new RepositoryError('Disclosure receipts could not be read.', cause); }
  }
}
