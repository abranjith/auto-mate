import { AutoMateError, CompatibilityStaleError, InputsIncompatibleError, ReplayNotAvailableError, RevisionIntegrityError, isTerminal, shortDigest, describeCompatibilityFinding, type AsOf, type CompatibilityReport, type DeclaredInput, type DeclaredOutput } from '@automate/core';
import type { Logger } from 'pino';
import type { TaskSessionRegistry, PhaseJob } from '../conversation/task-session-registry';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { TemplateRepository, TemplateRevisionRow } from '../db/repositories/template-repository';
import type { ExecutionReuseRepository } from '../db/repositories/execution-reuse-repository';
import type { CodeVersionRepository } from '../db/repositories/code-version-repository';
import type { UploadService } from '../ingestion/upload-service';
import type { FixtureService } from '../generation/fixture-service';
import type { CodeWorkspace } from '../generation/code-workspace';
import type { VerificationService } from '../verification/verification-service';
import type { CompatibilityService } from './compatibility-service';
import type { ExecutionInputs } from '../execution/execution-inputs';
import type { DatabaseConnection } from '../db/client';

export interface ReuseRunDependencies { readonly connection: DatabaseConnection; readonly tasks: TaskRepository; readonly executions: ExecutionRepository; readonly templates: TemplateRepository; readonly reuse: ExecutionReuseRepository; readonly versions: CodeVersionRepository; readonly uploads: UploadService; readonly inputs: ExecutionInputs; readonly fixtures: FixtureService; readonly workspace: CodeWorkspace; readonly verification: VerificationService; readonly compatibility: CompatibilityService; readonly registry: Pick<TaskSessionRegistry, 'assertCapacity' | 'track' | 'publish'>; readonly logger: Pick<Logger, 'info' | 'warn'> }
export interface StartSavedRun { readonly uploadIds: readonly number[]; readonly compatibilityDigest: string; readonly asOf?: AsOf; readonly asOfDate?: string; readonly timeZone?: string }
interface RunSnapshot { readonly templateName: string; readonly revisionNumber: number; readonly contentDigest: string; readonly asOfNotRecorded?: boolean }

function revisionFiles(templates: TemplateRepository, revision: TemplateRevisionRow) {
  return templates.listFiles(revision.id).map(({ path, role, content }) => ({ path, role: role as 'script' | 'test' | 'support', content }));
}

/** Creates saved-code executions and then checks them locally, with no provider call. */
export class ReuseRunService {
  constructor(private readonly deps: ReuseRunDependencies) {}

  start(templateId: number, request: StartSavedRun) {
    const checked = this.deps.compatibility.checkStaged(templateId, request);
    if (checked.digest !== request.compatibilityDigest) throw new CompatibilityStaleError();
    if (checked.report.status === 'incompatible') throw new InputsIncompatibleError();
    this.deps.registry.assertCapacity();
    const template = this.deps.templates.getById(templateId)!;
    const files = revisionFiles(this.deps.templates, checked.revision);
    let claimed: ReturnType<UploadService['attachWithinTransaction']> = [];
    const created = this.deps.tasks.createNamedWithExecution(template.name, template.description, checked.asOf, (tx, taskId, executionId) => {
      claimed = this.deps.uploads.attachWithinTransaction(taskId, request.uploadIds);
      for (const [position, uploadId] of request.uploadIds.entries()) this.deps.reuse.bind(tx, { executionId, uploadId, position, inputName: checked.contract.inputs[position]!.inputName });
      this.deps.reuse.record(tx, { executionId, kind: 'run', templateId, templateRevisionId: checked.revision.id, templateName: template.name, revisionNumber: checked.revision.revisionNumber, revisionDigest: checked.revision.contentDigest, compatibilityReport: checked.report, compatibilityDigest: checked.digest, mapping: null });
      this.deps.versions.materialize(tx, { executionId, files, entrypoint: checked.revision.entrypoint, summary: checked.revision.summary, declaredInputs: JSON.parse(checked.revision.declaredInputs) as DeclaredInput[], declaredOutputs: JSON.parse(checked.revision.declaredOutputs) as DeclaredOutput[], expectedDigest: checked.revision.contentDigest });
    });
    this.begin(created.execution.id, claimed, { templateName: template.name, revisionNumber: checked.revision.revisionNumber, contentDigest: checked.revision.contentDigest }, checked.report, checked.asOf);
    this.deps.logger.info({ templateId, revisionNumber: checked.revision.revisionNumber, executionId: created.execution.id }, 'saved-code run started');
    return created;
  }

  replay(executionId: number) {
    const source = this.deps.executions.getById(executionId);
    const origin = this.deps.reuse.getByExecution(executionId);
    const version = this.deps.versions.findFinal(executionId);
    const bindings = this.deps.reuse.listBindings(executionId);
    if (!source || !origin || (origin.kind !== 'run' && origin.kind !== 'replay') || !isTerminal(source.status as 'completed' | 'failed' | 'aborted' | 'rejected') || !version?.contentDigest || !bindings.length) throw new ReplayNotAvailableError();
    this.deps.registry.assertCapacity();
    const original = this.deps.versions.getByIdWithFiles(version.id)!;
    const report = origin.compatibilityReport ? JSON.parse(origin.compatibilityReport) as CompatibilityReport : null;
    if (!report) throw new ReplayNotAvailableError();
    const created = this.deps.connection.db.transaction((tx) => {
      const run = this.deps.executions.createReplay(tx, executionId);
      for (const binding of bindings) this.deps.reuse.bind(tx, { executionId: run.id, uploadId: binding.uploadId, position: binding.position, inputName: binding.inputName });
      this.deps.reuse.record(tx, { executionId: run.id, kind: 'replay', templateId: origin.templateId, templateRevisionId: origin.templateRevisionId, templateName: origin.templateName, revisionNumber: origin.revisionNumber, revisionDigest: origin.revisionDigest, compatibilityReport: report, compatibilityDigest: origin.compatibilityDigest, mapping: null });
      this.deps.versions.materialize(tx, { executionId: run.id, files: original.files.map(({ path, role, content }) => ({ path, role: role as 'script' | 'test' | 'support', content })), entrypoint: original.entrypoint, summary: original.summary ?? '', declaredInputs: JSON.parse(original.declaredInputs ?? '[]') as DeclaredInput[], declaredOutputs: JSON.parse(original.declaredOutputs ?? '[]') as DeclaredOutput[], expectedDigest: original.contentDigest! });
      return run;
    });
    const asOf: AsOf = created.asOfAt && created.asOfDate && created.asOfTimezone && created.asOfSource ? { at: Math.floor(created.asOfAt.getTime() / 1000), date: created.asOfDate, timeZone: created.asOfTimezone, source: created.asOfSource as AsOf['source'] } : report.asOf;
    this.begin(created.id, [], { templateName: origin.templateName, revisionNumber: origin.revisionNumber, contentDigest: origin.revisionDigest, asOfNotRecorded: source.asOfAt === null }, report, asOf);
    this.deps.logger.info({ sourceExecutionId: executionId, executionId: created.id }, 'saved-code replay started');
    return created;
  }

  private begin(executionId: number, claimed: ReturnType<UploadService['attachWithinTransaction']>, snapshot: RunSnapshot, report: CompatibilityReport, asOf: AsOf): void {
    const controller = new AbortController();
    const settled = this.postCommit(executionId, claimed, snapshot, report, asOf, controller.signal).catch((cause: unknown) => {
      const current = this.deps.executions.getById(executionId);
      const code = cause instanceof AutoMateError ? cause.code : 'REUSE_START_FAILED';
      const message = cause instanceof AutoMateError ? cause.message : 'The saved task could not be checked. Run it again to retry.';
      if (current?.status === 'pending' || current?.status === 'verifying') this.deps.executions.markSettled(executionId, controller.signal.aborted ? { status: 'aborted' } : { status: 'failed', errorCode: code, errorMessage: message });
      if (cause instanceof RevisionIntegrityError) this.deps.logger.warn({ executionId, code, digest: shortDigest(snapshot.contentDigest) }, 'saved-code revision failed its integrity check');
      else this.deps.logger.warn({ executionId, code }, 'saved-code run could not start');
    });
    this.deps.registry.track(executionId, { abort: () => controller.abort(), settled } satisfies PhaseJob);
  }

  private async postCommit(executionId: number, claimed: ReturnType<UploadService['attachWithinTransaction']>, snapshot: RunSnapshot, report: CompatibilityReport, asOf: AsOf, signal: AbortSignal): Promise<void> {
    const execution = this.deps.executions.getById(executionId)!;
    await this.deps.uploads.moveAttached(execution.taskId, claimed);
    signal.throwIfAborted();
    const version = this.deps.versions.findFinal(executionId)!;
    this.deps.workspace.project(version.id);
    this.deps.registry.publish(executionId, { type: 'reuse_started', templateName: snapshot.templateName, revisionNumber: snapshot.revisionNumber, digestShort: shortDigest(snapshot.contentDigest), asOfDate: asOf.date, timeZone: asOf.timeZone, compatibilityStatus: report.status, advisoryHeadlines: report.findings.filter((finding) => finding.severity === 'advisory').map((finding) => describeCompatibilityFinding(finding).headline), runtimeChanged: report.findings.some((finding) => finding.code === 'runtime_changed'), ...(snapshot.asOfNotRecorded ? { asOfNotRecorded: true } : {}), at: new Date().toISOString() });
    const inputs = this.deps.inputs.resolve(executionId);
    await this.deps.fixtures.materializeFixtures(executionId, inputs, signal);
    await this.deps.verification.verify(executionId, { signal });
  }
}
