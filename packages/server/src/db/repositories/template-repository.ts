import { count, desc, eq, inArray, lt, max, sql } from 'drizzle-orm';
import { AutoMateError, RepositoryError, TemplateNotFoundError, canonicalStringify, contractDigest, sha256Hex, computeVersionDigest, validateCodePath, type InputContract, type CodeFileRole, type DeclaredInput, type DeclaredOutput, RevisionIntegrityError } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { execution, executionReuse, taskTemplate, templateRevision, templateRevisionFile } from '../schema';

type Tx = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];
export type TemplateRow = typeof taskTemplate.$inferSelect;
export type TemplateRevisionRow = typeof templateRevision.$inferSelect;
export type TemplateRevisionFileRow = typeof templateRevisionFile.$inferSelect;
export interface RevisionFileInput { readonly path: string; readonly role: CodeFileRole; readonly content: string }
export interface RevisionInput { readonly sourceExecutionId: number; readonly contentDigest: string; readonly entrypoint: string; readonly summary: string; readonly declaredInputs: readonly DeclaredInput[]; readonly declaredOutputs: readonly DeclaredOutput[]; readonly inputContract: InputContract; readonly runtimeFingerprint: string; readonly runtimeDetail: unknown; readonly readsWallClock: boolean; readonly note?: string | null; readonly files: readonly RevisionFileInput[] }

function checkedFiles(input: RevisionInput) {
  const files = input.files.map((file) => ({ path: validateCodePath(file.path, file.role), role: file.role, content: file.content, byteSize: new TextEncoder().encode(file.content).length, sha256: sha256Hex(file.content) }));
  if (computeVersionDigest(files) !== input.contentDigest) throw new RevisionIntegrityError();
  validateCodePath(input.entrypoint, 'script');
  return files;
}

/** Typed errors pass through; a driver failure (a unique index, a trigger) becomes a `RepositoryError`. */
function written<T>(message: string, action: () => T): T {
  try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError(message, cause); }
}

/** Saved tasks own immutable revision rows and file copies, separate from their source tasks. */
export class TemplateRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  createWithFirstRevision(tx: Tx, template: { name: string; description: string }, input: RevisionInput): { template: TemplateRow; revision: TemplateRevisionRow } {
    return written('The saved task could not be created.', () => {
      const created = tx.insert(taskTemplate).values({ name: template.name, description: template.description }).returning().get();
      return { template: created, revision: this.insertRevision(tx, created.id, 1, input) };
    });
  }

  /** Append revision `MAX + 1`, read inside the caller's transaction; the unique index is the backstop for a race. */
  appendRevision(tx: Tx, templateId: number, input: RevisionInput): TemplateRevisionRow {
    return written('The saved task revision could not be added. Reload the saved task and try again.', () => {
      if (!tx.select({ id: taskTemplate.id }).from(taskTemplate).where(eq(taskTemplate.id, templateId)).get()) throw new TemplateNotFoundError(templateId);
      const number = (tx.select({ value: max(templateRevision.revisionNumber) }).from(templateRevision).where(eq(templateRevision.templateId, templateId)).get()?.value ?? 0) + 1;
      return this.insertRevision(tx, templateId, number, input);
    });
  }

  private insertRevision(tx: Tx, templateId: number, revisionNumber: number, input: RevisionInput): TemplateRevisionRow {
    const files = checkedFiles(input);
    const revision = tx.insert(templateRevision).values({ templateId, revisionNumber, sourceExecutionId: input.sourceExecutionId, contentDigest: input.contentDigest, entrypoint: input.entrypoint, summary: input.summary, declaredInputs: canonicalStringify(input.declaredInputs), declaredOutputs: canonicalStringify(input.declaredOutputs), inputContract: canonicalStringify(input.inputContract), contractDigest: contractDigest(input.inputContract), runtimeFingerprint: input.runtimeFingerprint, runtimeDetail: canonicalStringify(input.runtimeDetail), readsWallClock: input.readsWallClock, note: input.note ?? null }).returning().get();
    for (const file of files) tx.insert(templateRevisionFile).values({ revisionId: revision.id, ...file }).run();
    return revision;
  }

  getById(id: number): TemplateRow | undefined { return this.connection.db.select().from(taskTemplate).where(eq(taskTemplate.id, id)).get(); }
  getCurrentRevision(templateId: number): TemplateRevisionRow | undefined { return this.connection.db.select().from(templateRevision).where(eq(templateRevision.templateId, templateId)).orderBy(desc(templateRevision.revisionNumber)).limit(1).get(); }
  getRevision(id: number): TemplateRevisionRow | undefined { return this.connection.db.select().from(templateRevision).where(eq(templateRevision.id, id)).get(); }
  listFiles(revisionId: number): TemplateRevisionFileRow[] { return this.connection.db.select().from(templateRevisionFile).where(eq(templateRevisionFile.revisionId, revisionId)).orderBy(templateRevisionFile.path).all(); }
  listRevisions(templateId: number): TemplateRevisionRow[] { return this.connection.db.select().from(templateRevision).where(eq(templateRevision.templateId, templateId)).orderBy(desc(templateRevision.revisionNumber)).all(); }
  findBySourceExecution(executionId: number): TemplateRevisionRow | undefined { return this.connection.db.select().from(templateRevision).where(eq(templateRevision.sourceExecutionId, executionId)).get(); }

  /** Four queries per page: base ids, revision counts, latest revision, and distinct task counts. */
  list({ cursor, limit }: { cursor?: number | null; limit: number }) {
    const rows = this.connection.db.select().from(taskTemplate).where(cursor ? lt(taskTemplate.id, cursor) : undefined).orderBy(desc(taskTemplate.id)).limit(limit + 1).all();
    const page = rows.slice(0, limit), ids = page.map((row) => row.id);
    if (!ids.length) return { items: [], nextCursor: null, hasMore: false };
    const revisions = this.connection.db.select({ id: templateRevision.templateId, revisionCount: count(), currentRevisionNumber: max(templateRevision.revisionNumber) }).from(templateRevision).where(inArray(templateRevision.templateId, ids)).groupBy(templateRevision.templateId).all();
    const runs = this.connection.db.select({ id: executionReuse.templateId, runCount: sql<number>`count(distinct ${execution.taskId})`, lastRunAt: max(executionReuse.createdAt) }).from(executionReuse).innerJoin(execution, eq(execution.id, executionReuse.executionId)).where(inArray(executionReuse.templateId, ids)).groupBy(executionReuse.templateId).all();
    const revisionById = new Map(revisions.map((row) => [row.id, row]));
    const runById = new Map(runs.map((row) => [row.id, row]));
    const items = page.map((row) => ({ ...row, currentRevisionNumber: revisionById.get(row.id)?.currentRevisionNumber ?? 1, revisionCount: revisionById.get(row.id)?.revisionCount ?? 1, runCount: runById.get(row.id)?.runCount ?? 0, lastRunAt: runById.get(row.id)?.lastRunAt ?? null }));
    return { items, nextCursor: rows.length > limit ? page.at(-1)!.id : null, hasMore: rows.length > limit };
  }

  delete(templateId: number): { revisions: number } {
    return this.connection.db.transaction((tx) => {
      if (!tx.select({ id: taskTemplate.id }).from(taskTemplate).where(eq(taskTemplate.id, templateId)).get()) throw new TemplateNotFoundError(templateId);
      const revisions = tx.select({ value: count() }).from(templateRevision).where(eq(templateRevision.templateId, templateId)).get()?.value ?? 0;
      tx.delete(taskTemplate).where(eq(taskTemplate.id, templateId)).run();
      return { revisions };
    });
  }
}
