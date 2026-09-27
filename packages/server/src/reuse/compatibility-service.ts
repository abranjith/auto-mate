import { Value } from '@sinclair/typebox/value';
import { classifyFindings, InputContractSchema, RevisionIntegrityError, TemplateNotFoundError, TemplateRevisionNotFoundError, UploadAlreadyAttachedError, UploadNotFoundError, ValidationError, buildTableIndex, checkCompatibility, compatibilityDigest, resolveAsOf, type AsOf, type CompatibilityReport, type InputContract, type RuntimeDetail } from '@automate/core';
import type { Logger } from 'pino';
import type { TemplateRepository, TemplateRevisionRow } from '../db/repositories/template-repository';
import type { ExecutionReuseRepository } from '../db/repositories/execution-reuse-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { RuntimeEnvironmentRepository } from '../db/repositories/runtime-environment-repository';
import { defaultTimeZone } from '../execution/as-of-storage';

export interface CompatibilityServiceDependencies { readonly templates: TemplateRepository; readonly reuse: ExecutionReuseRepository; readonly executions: ExecutionRepository; readonly uploads: UploadRepository; readonly profiles: UploadProfileRepository; readonly runtime: RuntimeEnvironmentRepository; readonly logger: Pick<Logger, 'debug'>; readonly now?: () => Date }
export interface CompatibilityRequest { readonly uploadIds: readonly number[]; readonly asOfDate?: string | null; readonly timeZone?: string | null; readonly asOf?: AsOf }
export interface CheckedCompatibility { readonly report: CompatibilityReport; readonly digest: string; readonly asOf: AsOf; readonly revision: TemplateRevisionRow; readonly contract: InputContract }

function contractOf(revision: TemplateRevisionRow): InputContract {
  try {
    const value: unknown = JSON.parse(revision.inputContract);
    if (Value.Check(InputContractSchema, value)) return value;
  } catch { /* Integrity is reported below. */ }
  throw new RevisionIntegrityError();
}

/** Compare stored profiles and runtime metadata; never reads upload bytes or starts a process. */
export class CompatibilityService {
  constructor(private readonly deps: CompatibilityServiceDependencies) {}

  checkStaged(templateId: number, request: CompatibilityRequest): CheckedCompatibility {
    if (!this.deps.templates.getById(templateId)) throw new TemplateNotFoundError(templateId);
    const revision = this.deps.templates.getCurrentRevision(templateId);
    if (!revision) throw new TemplateRevisionNotFoundError(templateId);
    return this.check(revision, request, true);
  }

  checkExecution(executionId: number): CheckedCompatibility {
    const execution = this.deps.executions.getById(executionId);
    const reuse = this.deps.reuse.getByExecution(executionId);
    if (!execution || !reuse?.templateRevisionId) throw new TemplateRevisionNotFoundError(executionId);
    const revision = this.deps.templates.getRevision(reuse.templateRevisionId);
    if (!revision) throw new TemplateRevisionNotFoundError(reuse.templateRevisionId);
    const bindings = this.deps.reuse.listBindings(executionId);
    const uploads = bindings.length ? bindings.map((binding) => this.deps.uploads.getById(binding.uploadId)).filter((row): row is NonNullable<typeof row> => row !== undefined) : this.deps.uploads.listByTask(execution.taskId);
    const asOf = execution.asOfAt && execution.asOfDate && execution.asOfTimezone && execution.asOfSource ? { at: Math.floor(execution.asOfAt.getTime() / 1000), date: execution.asOfDate, timeZone: execution.asOfTimezone, source: execution.asOfSource as AsOf['source'] } : undefined;
    return this.check(revision, { uploadIds: uploads.map(({ id }) => id), asOf }, false);
  }

  private check(revision: TemplateRevisionRow, request: CompatibilityRequest, staged: boolean): CheckedCompatibility {
    const contract = contractOf(revision);
    const uploads = request.uploadIds.map((id) => {
      const upload = this.deps.uploads.getById(id);
      if (!upload) throw new UploadNotFoundError(id);
      if (staged && upload.taskId !== null) throw new UploadAlreadyAttachedError(id);
      return upload;
    });
    const inputs = uploads.map((upload, position) => ({ position, uploadId: upload.id, inputName: contract.inputs[position]?.inputName ?? upload.storedFilename, label: upload.originalFilename, format: upload.format as 'csv' | 'xlsx', sourceSha256: upload.sha256, tables: this.deps.profiles.listByUpload(upload.id) }));
    const index = buildTableIndex(inputs);
    const findings = classifyFindings(index.map(({ table }) => table)).required;
    const current = this.deps.runtime.getReady('script');
    const detail = current?.packageJson ? { pythonVersion: current.pythonVersion, uvVersion: current.uvVersion, platform: current.platform, arch: current.arch, packages: JSON.parse(current.packageJson) as RuntimeDetail['packages'] } : null;
    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const asOf = request.asOf ?? resolveAsOf({ nowMs, timeZone: request.timeZone ?? defaultTimeZone(), chosenDate: request.asOfDate });
    if (request.asOf && (request.asOf.timeZone !== (request.timeZone ?? request.asOf.timeZone) || request.asOf.date !== (request.asOfDate ?? request.asOf.date))) throw new ValidationError('The as-of date or time zone changed. Check compatibility again.');
    if (request.asOf) {
      if (asOf.source === 'copied') throw new ValidationError('Choose a date for the new run.');
      const resolved = resolveAsOf({ nowMs: asOf.source === 'now' ? asOf.at * 1000 : nowMs, timeZone: asOf.timeZone, ...(asOf.source === 'chosen' ? { chosenDate: asOf.date } : {}) });
      if (resolved.date !== asOf.date || (asOf.source === 'chosen' && resolved.at !== asOf.at) || (asOf.source === 'now' && asOf.at * 1000 > nowMs)) throw new ValidationError('The as-of date changed. Check compatibility again.');
    }
    const report = checkCompatibility(contract, { inputs: inputs.map((input) => ({ position: input.position, uploadId: input.uploadId, label: input.label, format: input.format, tables: input.tables, profiled: uploads[input.position]?.profileStatus === 'profiled' })), findings, tableIndex: index }, { templateId: revision.templateId, revisionNumber: revision.revisionNumber, revisionRuntime: { fingerprint: revision.runtimeFingerprint, detail: JSON.parse(revision.runtimeDetail) as RuntimeDetail }, currentRuntime: current?.fingerprint && detail ? { fingerprint: current.fingerprint, detail } : null, readsWallClock: revision.readsWallClock, asOf });
    this.deps.logger.debug({ templateId: revision.templateId, status: report.status, blocking: report.findings.filter((item) => item.severity === 'blocking').length, advisory: report.findings.filter((item) => item.severity === 'advisory').length }, 'saved task compatibility checked');
    return { report, digest: compatibilityDigest(report), asOf, revision, contract };
  }
}
