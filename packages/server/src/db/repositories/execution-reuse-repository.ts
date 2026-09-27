import { and, desc, eq, lt, max } from 'drizzle-orm';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { AutoMateError, RepositoryError, ValidationError, canonicalStringify, type CompatibilityReport, type RepairMapping, type ReuseKind } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { execution, executionInputBinding, executionReuse } from '../schema';

type Tx = Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0];
export type ExecutionReuseRow = typeof executionReuse.$inferSelect;
export type InputBindingRow = typeof executionInputBinding.$inferSelect;
const ReuseInputSchema = Type.Object({ executionId: Type.Integer({ minimum: 1 }), kind: Type.Union([Type.Literal('run'), Type.Literal('replay'), Type.Literal('repair')]), templateId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), templateRevisionId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), templateName: Type.String(), revisionNumber: Type.Integer({ minimum: 1 }), revisionDigest: Type.String({ pattern: '^[0-9a-f]{64}$' }), compatibilityReport: Type.Union([Type.Unknown(), Type.Null()]), compatibilityDigest: Type.Union([Type.String(), Type.Null()]), mapping: Type.Union([Type.Unknown(), Type.Null()]) }, { additionalProperties: false });
export interface ReuseInput { readonly executionId: number; readonly kind: ReuseKind; readonly templateId: number | null; readonly templateRevisionId: number | null; readonly templateName: string; readonly revisionNumber: number; readonly revisionDigest: string; readonly compatibilityReport: CompatibilityReport | null; readonly compatibilityDigest: string | null; readonly mapping: RepairMapping | null }

function written<T>(message: string, action: () => T): T {
  try { return action(); } catch (cause) { if (cause instanceof AutoMateError) throw cause; throw new RepositoryError(message, cause); }
}

/** A plain filename only, including Windows reserved names and traversal checks. */
export function validateInputName(name: string): string {
  const stem = name.split('.')[0]?.toUpperCase();
  if (!name || name === '.' || name === '..' || name.includes('..') || /[\\/:*?"<>|]/.test(name) || [...name].some((char) => char.charCodeAt(0) < 0x20) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem ?? '')) throw new ValidationError(`Input name ${name} is not a safe filename.`);
  return name;
}

/** Run lineage and input-name bindings. Both are task-owned through execution. */
export class ExecutionReuseRepository {
  constructor(private readonly connection: DatabaseConnection) {}

  record(tx: Tx, input: ReuseInput): ExecutionReuseRow {
    if (!Value.Check(ReuseInputSchema, input) || (input.kind !== 'repair' && input.mapping !== null) || ((input.compatibilityReport === null) !== (input.compatibilityDigest === null))) throw new ValidationError('The saved-task run details are invalid.');
    return written('The saved-task run details could not be recorded.', () => tx.insert(executionReuse).values({ executionId: input.executionId, kind: input.kind, templateId: input.templateId, templateRevisionId: input.templateRevisionId, templateName: input.templateName, revisionNumber: input.revisionNumber, revisionDigest: input.revisionDigest, compatibilityReport: input.compatibilityReport ? canonicalStringify(input.compatibilityReport) : null, compatibilityDigest: input.compatibilityDigest, mapping: input.mapping ? canonicalStringify(input.mapping) : null }).returning().get());
  }

  bind(tx: Tx, input: { executionId: number; uploadId: number; position: number; inputName: string }): InputBindingRow {
    if (!Number.isInteger(input.position) || input.position < 0) throw new ValidationError('The input position is invalid.');
    const inputName = validateInputName(input.inputName);
    return written('Each file can be bound to one input name only once.', () => tx.insert(executionInputBinding).values({ ...input, inputName }).returning().get());
  }

  getByExecution(executionId: number): ExecutionReuseRow | undefined { return this.connection.db.select().from(executionReuse).where(eq(executionReuse.executionId, executionId)).get(); }
  listBindings(executionId: number): InputBindingRow[] { return this.connection.db.select().from(executionInputBinding).where(eq(executionInputBinding.executionId, executionId)).orderBy(executionInputBinding.position).all(); }
  countTasksOfTemplate(templateId: number): number {
    const row = this.connection.client.prepare('select count(distinct e.task_id) n from execution_reuse r join execution e on e.id = r.execution_id where r.template_id = ?').get(templateId) as { n: number };
    return row.n;
  }

  /** Distinct tasks ordered by their latest saved-task run. */
  listTasksOfTemplate(templateId: number, page: { cursor?: number | null; limit: number }) {
    const latest = max(execution.id);
    return this.connection.db.select({ taskId: execution.taskId, latestExecutionId: latest }).from(executionReuse).innerJoin(execution, eq(execution.id, executionReuse.executionId)).where(and(eq(executionReuse.templateId, templateId), page.cursor ? lt(execution.id, page.cursor) : undefined)).groupBy(execution.taskId).orderBy(desc(latest)).limit(page.limit + 1).all();
  }
}
