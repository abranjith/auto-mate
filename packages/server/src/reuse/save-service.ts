import { ExecutionAlreadySavedError, ExecutionNotFoundError, ExecutionNotSaveableError, RevisionIntegrityError, TEMPLATE_NAME_MAX_CHARS, ValidationError, buildInputContract, buildTableIndex, computeVersionDigest, describeRunState, findWallClockReads, isSavedCodeRun, parseFindingKey, recordRules, renderMappingInstructions, sha256Hex, type DeclaredInput, type DeclaredOutput, type ExecutionStatus, type Finding, type InputContract, type RecordedRule, type RepairMapping, type ReuseKind } from '@automate/core';
import type { Logger } from 'pino';
import type { DatabaseConnection } from '../db/client';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { CodeVersionRepository } from '../db/repositories/code-version-repository';
import type { ApprovalRepository } from '../db/repositories/approval-repository';
import type { VerificationRepository } from '../db/repositories/verification-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { ClarificationRepository } from '../db/repositories/clarification-repository';
import type { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import type { TemplateRepository, RevisionInput } from '../db/repositories/template-repository';
import type { ExecutionReuseRepository } from '../db/repositories/execution-reuse-repository';
import type { ExecutionInputs } from '../execution/execution-inputs';

export interface SaveServiceDependencies { readonly connection: DatabaseConnection; readonly executions: ExecutionRepository; readonly tasks: TaskRepository; readonly versions: CodeVersionRepository; readonly approvals: ApprovalRepository; readonly verifications: VerificationRepository; readonly profiles: UploadProfileRepository; readonly clarifications: ClarificationRepository; readonly events: ConversationEventRepository; readonly templates: TemplateRepository; readonly reuse: ExecutionReuseRepository; readonly inputs: ExecutionInputs; readonly logger: Pick<Logger, 'info' | 'warn'> }

function parseArray<T>(text: string | null): T[] {
  if (!text) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new RevisionIntegrityError();
  return value as T[];
}

/**
 * A promoted revision's note: the repair's guidance, which already is the rendered mapping
 * sentences plus the person's note (TASK-009). The mapping is re-rendered only for a repair
 * row that somehow carries no guidance, so the note never repeats itself.
 */
function promotionNote(mapping: string | null, guidance: string | null, contract: InputContract): string | null {
  if (guidance?.trim()) return guidance;
  return mapping ? renderMappingInstructions(JSON.parse(mapping) as RepairMapping, contract) : null;
}

function answered(questions: ReturnType<ClarificationRepository['listByExecution']>) {
  return questions.flatMap((batch) => batch.questions.map((question) => ({ findingKey: question.findingKey, answer: question.answer ?? question.proposedDefault, proposedDefault: question.proposedDefault, question: question.promptText, status: batch.status })));
}

/** Copies only shapes, decisions, runtime, and code from a person-accepted run. */
export class SaveService {
  constructor(private readonly deps: SaveServiceDependencies) {}

  preview(executionId: number) {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    const task = this.deps.tasks.getById(execution.taskId)!;
    const already = this.deps.templates.findBySourceExecution(executionId);
    const reuse = this.deps.reuse.getByExecution(executionId);
    let prepared: ReturnType<SaveService['prepare']> | null = null;
    let reason: string | null = null;
    if (execution.status === 'completed' && !already && !isSavedCodeRun(reuse?.kind as 'run' | 'replay' | 'repair' | null)) {
      try { prepared = this.prepare(executionId); }
      catch (cause) { if (cause instanceof ExecutionNotSaveableError || cause instanceof RevisionIntegrityError) reason = cause.message; else throw cause; }
    }
    const contract = prepared?.input.inputContract;
    const target = reuse?.kind === 'repair' && reuse.templateId ? this.deps.templates.getById(reuse.templateId) : undefined;
    return { saveable: !!prepared, reason: execution.status !== 'completed' ? 'Only a run you accepted can be saved.' : already ? 'This run is already saved.' : isSavedCodeRun(reuse?.kind as 'run' | 'replay' | 'repair' | null) ? 'This run already used saved code.' : reason, alreadySaved: already ? { templateId: already.templateId, name: this.deps.templates.getById(already.templateId)?.name ?? '', revisionNumber: already.revisionNumber } : null, defaultName: task.name, promoteTarget: target ? { templateId: target.id, name: target.name, nextRevisionNumber: (this.deps.templates.getCurrentRevision(target.id)?.revisionNumber ?? 0) + 1 } : null, keeps: { inputs: contract?.inputs.map((input) => ({ label: input.label, format: input.format, sheets: input.tables.map((table) => table.selector.kind === 'only' ? '' : table.selector.name), requiredColumns: input.tables.flatMap((table) => table.columns.filter((column) => column.required).map((column) => column.name)) })) ?? [], ruleCount: contract?.rules.length ?? 0, noteCount: contract?.notes.length ?? 0 }, readsWallClock: prepared?.clock.map(({ path, line }) => ({ path, line })) ?? [] };
  }

  save(executionId: number, request: { name?: string; templateId?: number }) {
    const execution = this.deps.executions.getById(executionId);
    if (!execution) throw new ExecutionNotFoundError(executionId);
    if (execution.status !== 'completed') throw ExecutionNotSaveableError.notAccepted(describeRunState({ status: execution.status as ExecutionStatus, errorCode: execution.errorCode }).label);
    const reuse = this.deps.reuse.getByExecution(executionId);
    if (reuse && isSavedCodeRun(reuse.kind as ReuseKind)) throw ExecutionNotSaveableError.usedSavedTask(reuse.templateName, reuse.revisionNumber);
    const already = this.deps.templates.findBySourceExecution(executionId);
    if (already) throw new ExecutionAlreadySavedError(already.templateId, already.revisionNumber);
    const task = this.deps.tasks.getById(execution.taskId)!;
    const name = request.name?.trim() || task.name;
    if (!name || name.length > TEMPLATE_NAME_MAX_CHARS) throw new ValidationError(`The saved task name must have 1 to ${TEMPLATE_NAME_MAX_CHARS} characters.`);
    if (request.templateId && (reuse?.kind !== 'repair' || reuse.templateId !== request.templateId)) throw ExecutionNotSaveableError.notFromTemplate();
    const prepared = this.prepare(executionId);
    const created = this.deps.connection.db.transaction((tx) => request.templateId ? { template: this.deps.templates.getById(request.templateId)!, revision: this.deps.templates.appendRevision(tx, request.templateId, { ...prepared.input, note: promotionNote(reuse?.mapping ?? null, execution.guidance, prepared.input.inputContract) }) } : this.deps.templates.createWithFirstRevision(tx, { name, description: task.description }, prepared.input));
    this.deps.events.append(executionId, { seq: this.deps.events.maxSeq(executionId) + 1, type: 'task_saved', templateId: created.template.id, name: created.template.name, revisionNumber: created.revision.revisionNumber, at: new Date().toISOString() });
    this.deps.logger.info({ executionId, templateId: created.template.id, revisionNumber: created.revision.revisionNumber, fileCount: prepared.input.files.length, readsWallClock: prepared.input.readsWallClock }, 'task saved');
    return created;
  }

  private prepare(executionId: number): { input: RevisionInput; clock: ReturnType<typeof findWallClockReads> } {
    const version = this.deps.versions.findFinal(executionId);
    if (!version || !version.contentDigest) throw new RevisionIntegrityError();
    const files = this.deps.versions.listFiles([version.id]);
    if (files.some((file) => sha256Hex(file.content) !== file.sha256) || computeVersionDigest(files) !== version.contentDigest) throw new RevisionIntegrityError();
    const approval = this.deps.approvals.getGranted(executionId);
    const verified = approval && this.deps.verifications.getById(approval.verificationRunId);
    if (!verified) throw ExecutionNotSaveableError.noApproval();
    const resolved = this.deps.inputs.resolve(executionId);
    const inputs = resolved.map(({ position, inputName, upload }) => ({ position, uploadId: upload.id, inputName, label: upload.originalFilename, format: upload.format as 'csv' | 'xlsx', sourceSha256: upload.sha256, tables: this.deps.profiles.listByUpload(upload.id) }));
    const index = buildTableIndex(inputs);
    const answers = answered(this.deps.clarifications.listByExecution(executionId));
    const findings = answers.flatMap((answer): Finding[] => answer.findingKey ? [{ findingKey: answer.findingKey, profileIndex: parseFindingKey(answer.findingKey).profileIndex, columnPosition: 0, impact: 'meaning', question: answer.question, rationale: '', options: [{ value: answer.answer ?? '' , label: answer.answer ?? '' }], proposedDefault: answer.proposedDefault ?? '' }] : []);
    const rules: RecordedRule[] = recordRules(answers, findings, index);
    const notes = answers.filter((answer) => !answer.findingKey).map((answer) => ({ question: answer.question, answer: answer.answer ?? '' }));
    const contract: InputContract = buildInputContract({ inputs, declaredInputs: parseArray<DeclaredInput>(version.declaredInputs), answeredFindings: rules, notes });
    const clock = findWallClockReads(files);
    return { input: { sourceExecutionId: executionId, contentDigest: version.contentDigest, entrypoint: version.entrypoint, summary: version.summary ?? '', declaredInputs: parseArray<DeclaredInput>(version.declaredInputs), declaredOutputs: parseArray<DeclaredOutput>(version.declaredOutputs), inputContract: contract, runtimeFingerprint: verified.runtimeFingerprint, runtimeDetail: JSON.parse(verified.runtimeDetail) as unknown, readsWallClock: clock.length > 0, files: files.map(({ path, role, content }) => ({ path, role: role as 'script' | 'test' | 'support', content })) }, clock };
  }
}
