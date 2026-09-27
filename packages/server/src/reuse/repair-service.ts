import { AutoMateError, ERROR_CODES, ReplayNotAvailableError, ValidationError, buildTableIndex, classifyFindings, isTerminal, rekeyRules, renderMappingInstructions, validateMapping, type AsOf, type ExecutionStatus, type RepairMapping } from '@automate/core';
import type { Logger } from 'pino';
import type { DatabaseConnection } from '../db/client';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { TemplateRepository } from '../db/repositories/template-repository';
import type { ExecutionReuseRepository } from '../db/repositories/execution-reuse-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { DisclosureConsentRepository } from '../db/repositories/disclosure-consent-repository';
import type { UploadService } from '../ingestion/upload-service';
import type { DisclosureService } from '../disclosure/disclosure-service';
import type { PreflightService } from '../disclosure/preflight-service';
import type { TaskSessionRegistry } from '../conversation/task-session-registry';
import type { CompatibilityService } from './compatibility-service';

export interface RepairDependencies { readonly connection: DatabaseConnection; readonly tasks: TaskRepository; readonly executions: ExecutionRepository; readonly templates: TemplateRepository; readonly reuse: ExecutionReuseRepository; readonly uploads: UploadRepository; readonly profiles: UploadProfileRepository; readonly uploadService: UploadService; readonly disclosure: DisclosureService; readonly consents: DisclosureConsentRepository; readonly preflight: PreflightService; readonly compatibility: CompatibilityService; readonly registry: Pick<TaskSessionRegistry, 'assertCapacity' | 'start'>; readonly logger: Pick<Logger, 'info'> }
export interface StartRepairRequest { readonly uploadIds: readonly number[]; readonly mapping: RepairMapping; readonly consent: { readonly consentId: number; readonly payloadDigest: string }; readonly asOf?: AsOf; readonly asOfDate?: string; readonly timeZone?: string }
export interface RepairExecutionRequest { readonly mapping?: RepairMapping; readonly consent: { readonly consentId: number; readonly payloadDigest: string }; readonly note?: string }

function hasChoices(mapping: RepairMapping): boolean { return mapping.columns.length + mapping.sheets.length + mapping.decisions.length > 0; }
function emptyMapping(note: string | null): RepairMapping { return { columns: [], sheets: [], decisions: [], note }; }
function preflightChoices(mapping: RepairMapping, tables: readonly import('@automate/core').TableProfile[]) {
  const required = new Set(classifyFindings(tables).required.map((finding) => finding.findingKey));
  return mapping.decisions.filter((item) => required.has(item.findingKey)).map((item) => ({ findingKey: item.findingKey, choice: item.answer }));
}

/** AI repair from approved new-file disclosure, with saved code kept out of the prompt. */
export class RepairService {
  constructor(private readonly deps: RepairDependencies) {}

  async startFromTemplate(templateId: number, request: StartRepairRequest) {
    const checked = this.deps.compatibility.checkStaged(templateId, request);
    const template = this.deps.templates.getById(templateId)!;
    const tables = request.uploadIds.flatMap((id, inputPosition) => this.deps.profiles.listByUpload(id).map((table) => ({ inputPosition, table })));
    validateMapping(request.mapping, checked.report, tables);
    if (!hasChoices(request.mapping) && !request.mapping.note?.trim()) throw new ValidationError('Add a note explaining what you want repaired.');
    const consent = this.deps.disclosure.verifyAcknowledgement(request.consent.consentId, request.consent.payloadDigest, request.uploadIds);
    const inputs = request.uploadIds.map((id, position) => ({ position, uploadId: id, inputName: checked.contract.inputs[position]?.inputName ?? '', label: this.deps.uploads.getById(id)?.originalFilename ?? '', format: this.deps.uploads.getById(id)?.format as 'csv' | 'xlsx', sourceSha256: this.deps.uploads.getById(id)?.sha256 ?? '', tables: this.deps.profiles.listByUpload(id) }));
    const seeded = new Map(Object.entries(rekeyRules(checked.contract.rules, buildTableIndex(inputs))));
    const decisions = this.deps.preflight.resolveDecisions(request.uploadIds, preflightChoices(request.mapping, inputs.flatMap((input) => input.tables)), undefined, seeded);
    const guidance = renderMappingInstructions(request.mapping, checked.contract);
    this.deps.registry.assertCapacity();
    let claimed: ReturnType<UploadService['attachWithinTransaction']> = [];
    const created = this.deps.tasks.createNamedWithExecution(template.name, template.description, checked.asOf, (tx, taskId, executionId) => {
      claimed = this.deps.uploadService.attachWithinTransaction(taskId, request.uploadIds);
      this.deps.consents.attachToTask(consent.id, taskId);
      this.deps.preflight.persist(executionId, decisions, tx);
      this.deps.reuse.record(tx, { executionId, kind: 'repair', templateId, templateRevisionId: checked.revision.id, templateName: template.name, revisionNumber: checked.revision.revisionNumber, revisionDigest: checked.revision.contentDigest, compatibilityReport: checked.report, compatibilityDigest: checked.digest, mapping: request.mapping });
    }, guidance);
    await this.deps.uploadService.moveAttached(created.task.id, claimed);
    this.deps.registry.start(created.execution, created.task);
    this.deps.logger.info({ templateId, revisionNumber: checked.revision.revisionNumber, executionId: created.execution.id }, 'saved-task repair started');
    return created;
  }

  repairExecution(executionId: number, request: RepairExecutionRequest) {
    const source = this.deps.executions.getById(executionId);
    const origin = this.deps.reuse.getByExecution(executionId);
    if (!source || !origin) throw new ReplayNotAvailableError('Only a run of a saved task can be repaired from here. Use Run again on other runs.');
    if (!isTerminal(source.status as ExecutionStatus)) throw new ReplayNotAvailableError('This run is still going. Wait for it to finish, or cancel it, before repairing it.');
    const task = this.deps.tasks.getById(source.taskId)!;
    if (this.deps.executions.listByTask(task.id).some((run) => run.id > executionId)) throw new ReplayNotAvailableError('A newer run of this task exists. Repair the latest run instead.');
    const sourceBindings = this.deps.reuse.listBindings(executionId);
    const uploadIds = sourceBindings.length ? sourceBindings.map((binding) => binding.uploadId) : this.deps.uploads.listByTask(task.id).map(({ id }) => id);
    const consent = this.deps.disclosure.verifyAcknowledgement(request.consent.consentId, request.consent.payloadDigest, uploadIds);
    const checked = origin.templateRevisionId ? this.deps.compatibility.checkExecution(executionId) : null;
    if (request.mapping && !checked) throw new AutoMateError(ERROR_CODES.TEMPLATE_REVISION_NOT_FOUND, 'The saved task was deleted. Add a note to repair this run without a mapping.');
    const mapping = request.mapping ?? emptyMapping(request.note?.trim() || null);
    if (checked) validateMapping(mapping, checked.report, uploadIds.flatMap((id, inputPosition) => this.deps.profiles.listByUpload(id).map((table) => ({ inputPosition, table }))));
    if (!hasChoices(mapping) && !mapping.note?.trim()) throw new ValidationError('Add a note explaining what you want repaired.');
    const guidance = checked ? renderMappingInstructions(mapping, checked.contract) : mapping.note!;
    const decisions = this.deps.preflight.resolveDecisions(uploadIds, preflightChoices(mapping, uploadIds.flatMap((id) => this.deps.profiles.listByUpload(id))), task.id);
    this.deps.registry.assertCapacity();
    const run = this.deps.connection.db.transaction((tx) => {
      if (consent.taskId === null) this.deps.consents.attachToTask(consent.id, task.id);
      const created = this.deps.executions.createRepairRun(tx, executionId, guidance);
      this.deps.preflight.persist(created.id, decisions, tx);
      this.deps.reuse.record(tx, { executionId: created.id, kind: 'repair', templateId: origin.templateId, templateRevisionId: origin.templateRevisionId, templateName: origin.templateName, revisionNumber: origin.revisionNumber, revisionDigest: origin.revisionDigest, compatibilityReport: checked?.report ?? null, compatibilityDigest: checked?.digest ?? null, mapping });
      return created;
    });
    this.deps.registry.start(run, task);
    this.deps.logger.info({ sourceExecutionId: executionId, executionId: run.id, templateId: origin.templateId }, 'saved-task repair started');
    return { task, execution: run };
  }
}
