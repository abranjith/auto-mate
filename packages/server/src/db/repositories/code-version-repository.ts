import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import {
  AutoMateError,
  CodeVersionImmutableError,
  CodeVersionNotFoundError,
  RepositoryError,
  ValidationError,
  computeVersionDigest,
  utf8ByteLength,
  validateCodePath,
  type CodeFileRole,
  type DeclaredInput,
  type DeclaredOutput,
} from '@automate/core';
import type { DatabaseConnection } from '../client';
import { codeFile, codeVersion, generationAttempt } from '../schema';

export type CodeVersionRow = typeof codeVersion.$inferSelect;
export type CodeFileRow = typeof codeFile.$inferSelect;
export interface CodeVersionWithFiles extends CodeVersionRow { readonly files: readonly CodeFileRow[] }
export interface NewCodeFile { readonly path: string; readonly role: CodeFileRole; readonly content: string }
export interface FinalDetails { readonly entrypoint: string; readonly declaredInputs: readonly DeclaredInput[]; readonly declaredOutputs: readonly DeclaredOutput[]; readonly summary: string }
type Tx = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];

/** The relative directory a version's files are projected into. Forward slashes: it is stored, not joined. */
export function attemptDirPath(executionId: number, attempt: number): string {
  return `scripts/${executionId}/attempt-${attempt}`;
}

/**
 * Exclusive persistence boundary for code versions and their files.
 *
 * Immutability is enforced HERE, not only wherever a caller happens to be
 * correct: a file may be inserted, replaced, or removed only while its version
 * is a `draft`, and sealing computes the digest from the stored rows inside
 * the same transaction that marks the version sealed.
 */
export class CodeVersionRepository {
  constructor(private readonly connection: DatabaseConnection, private readonly now: () => Date = () => new Date()) {}

  /** Open the execution's one draft at an application-allocated attempt number. */
  openDraft(executionId: number, attempt: number): CodeVersionRow {
    return this.write('opened', () => this.connection.db.insert(codeVersion).values({ executionId, attempt, dirPath: attemptDirPath(executionId, attempt), createdAt: this.now() }).returning().get());
  }

  /** Insert or replace one file of a draft; the path is validated again here, independently of the tool. */
  putFile(versionId: number, file: NewCodeFile): CodeFileRow {
    const path = validateCodePath(file.path, file.role);
    const values = { codeVersionId: versionId, path, role: file.role, content: file.content, byteSize: utf8ByteLength(file.content), sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'), createdAt: this.now() };
    return this.write('saved', () => this.connection.db.transaction((tx) => {
      this.requireDraft(tx, versionId);
      tx.delete(codeFile).where(and(eq(codeFile.codeVersionId, versionId), eq(codeFile.path, path))).run();
      return tx.insert(codeFile).values(values).returning().get();
    }));
  }

  /** Seal a draft: compute its digest from the stored rows and freeze it, atomically. */
  seal(versionId: number, status: 'sealed' | 'superseded' = 'sealed'): CodeVersionRow {
    return this.write('sealed', () => this.connection.db.transaction((tx) => {
      this.requireDraft(tx, versionId);
      const files = tx.select().from(codeFile).where(eq(codeFile.codeVersionId, versionId)).all();
      if (files.length === 0) throw new ValidationError('A version with no files cannot be sealed. Write the script with write_script first.');
      const sealed = tx.update(codeVersion).set({ status, contentDigest: computeVersionDigest(files), sealedAt: this.now() }).where(and(eq(codeVersion.id, versionId), eq(codeVersion.status, 'draft'))).returning().get();
      if (!sealed) throw new CodeVersionImmutableError(versionId);
      return sealed;
    }));
  }

  /** Move a draft to another attempt number, before it is sealed, when that number was already consumed. */
  renumberDraft(versionId: number, attempt: number): CodeVersionRow {
    return this.write('renumbered', () => this.connection.db.transaction((tx) => {
      const draft = this.requireDraft(tx, versionId);
      return tx.update(codeVersion).set({ attempt, dirPath: attemptDirPath(draft.executionId, attempt) }).where(eq(codeVersion.id, versionId)).returning().get();
    }));
  }

  /** Freeze an untested leftover draft as `superseded` so it stays readable; delete it when it holds no files. */
  supersedeDraft(executionId: number): CodeVersionRow | undefined {
    const draft = this.findDraft(executionId);
    if (!draft) return undefined;
    if (this.listFiles([draft.id]).length === 0) {
      this.write('discarded', () => this.connection.db.delete(codeVersion).where(and(eq(codeVersion.id, draft.id), eq(codeVersion.status, 'draft'))).run());
      return undefined;
    }
    return this.seal(draft.id, 'superseded');
  }

  /** Record whether a sealed version's own tests passed. Recorded, never enforced. */
  markTested(versionId: number, passed: boolean): CodeVersionRow {
    return this.updateSealed(versionId, { status: passed ? 'tested_pass' : 'tested_fail', testsPassed: passed });
  }

  /** Mark a sealed version as the execution's final one; the partial unique index allows exactly one. */
  markFinal(versionId: number, details: FinalDetails): CodeVersionRow {
    return this.updateSealed(versionId, { isFinal: true, entrypoint: details.entrypoint, declaredInputs: JSON.stringify(details.declaredInputs), declaredOutputs: JSON.stringify(details.declaredOutputs), summary: details.summary });
  }

  getById(id: number): CodeVersionRow | undefined {
    return this.read(() => this.connection.db.select().from(codeVersion).where(eq(codeVersion.id, id)).get());
  }

  getByIdWithFiles(id: number): CodeVersionWithFiles | undefined {
    const version = this.getById(id);
    return version ? { ...version, files: this.listFiles([id]) } : undefined;
  }

  /** Every version of an execution, newest attempt first, each with its files. */
  listByExecution(executionId: number): CodeVersionWithFiles[] {
    const versions = this.read(() => this.connection.db.select().from(codeVersion).where(eq(codeVersion.executionId, executionId)).orderBy(desc(codeVersion.attempt)).all());
    const files = this.listFiles(versions.map(({ id }) => id));
    return versions.map((version) => ({ ...version, files: files.filter(({ codeVersionId }) => codeVersionId === version.id) }));
  }

  findDraft(executionId: number): CodeVersionRow | undefined {
    return this.read(() => this.connection.db.select().from(codeVersion).where(and(eq(codeVersion.executionId, executionId), eq(codeVersion.status, 'draft'))).get());
  }

  findFinal(executionId: number): CodeVersionRow | undefined {
    return this.read(() => this.connection.db.select().from(codeVersion).where(and(eq(codeVersion.executionId, executionId), eq(codeVersion.isFinal, true))).get());
  }

  /** The next attempt number: one past every number either versions or attempts have used. */
  nextAttemptNumber(executionId: number): number {
    return this.read(() => {
      const versions = this.connection.db.select({ value: max(codeVersion.attempt) }).from(codeVersion).where(eq(codeVersion.executionId, executionId)).get()?.value ?? 0;
      const attempts = this.connection.db.select({ value: max(generationAttempt.attempt) }).from(generationAttempt).where(eq(generationAttempt.executionId, executionId)).get()?.value ?? 0;
      return Math.max(versions, attempts) + 1;
    });
  }

  listFiles(versionIds: readonly number[]): CodeFileRow[] {
    if (versionIds.length === 0) return [];
    return this.read(() => this.connection.db.select().from(codeFile).where(inArray(codeFile.codeVersionId, [...versionIds])).orderBy(asc(codeFile.codeVersionId), asc(codeFile.path)).all());
  }

  private requireDraft(tx: Tx, versionId: number): CodeVersionRow {
    const version = tx.select().from(codeVersion).where(eq(codeVersion.id, versionId)).get();
    if (!version) throw new CodeVersionNotFoundError(versionId);
    if (version.status !== 'draft') throw new CodeVersionImmutableError(versionId);
    return version;
  }

  private updateSealed(versionId: number, patch: Partial<typeof codeVersion.$inferInsert>): CodeVersionRow {
    return this.write('updated', () => this.connection.db.transaction((tx) => {
      const version = tx.select().from(codeVersion).where(eq(codeVersion.id, versionId)).get();
      if (!version) throw new CodeVersionNotFoundError(versionId);
      if (version.status === 'draft') throw new ValidationError(`Code version ${versionId} must be sealed first.`);
      return tx.update(codeVersion).set(patch).where(eq(codeVersion.id, versionId)).returning().get();
    }));
  }

  private read<T>(action: () => T): T {
    try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError('Code versions could not be read.', cause); }
  }
  private write<T>(verb: string, action: () => T): T {
    try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError(`The code version could not be ${verb}.`, cause); }
  }
}
