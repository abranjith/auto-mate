import { Value } from '@sinclair/typebox/value';
import { Router } from 'express';
import { TemplateCompatibilityQuerySchema, SaveExecutionRequestSchema, StartTemplateRunRequestSchema, StartTemplateRepairRequestSchema, RepairExecutionRequestSchema, ValidationError, TemplateNotFoundError, TemplateRevisionNotFoundError, type SaveExecutionRequest, type TemplateCompatibilityQuery, type StartTemplateRunRequest, type StartTemplateRepairRequest, type RepairExecutionRequest } from '@automate/core';
import type { ServerConfig } from '../config/env';
import { originGuard } from '../middleware/origin-guard';
import { presentExecution, presentTask } from '../conversation/presenters';
import type { TemplateRepository } from '../db/repositories/template-repository';
import type { ExecutionReuseRepository } from '../db/repositories/execution-reuse-repository';
import type { HistoryRepository } from '../db/repositories/history-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import { presentRevision, presentRevisionFile, presentRevisionSummary, presentTemplate, type SaveService, type CompatibilityService, type ReuseRunService, type RepairService } from '../reuse/index';

export interface TemplateRouteDependencies { config: ServerConfig; templates: TemplateRepository; reuse: ExecutionReuseRepository; history: HistoryRepository; executions: ExecutionRepository; save: SaveService; compatibility: CompatibilityService; runs: ReuseRunService; repairs: RepairService }

function id(value: unknown): number {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(parsed)) throw new ValidationError('The id must be a positive integer.');
  return parsed;
}
function page(query: Record<string, unknown>): { cursor?: number; limit: number } {
  if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit')) throw new ValidationError('Saved-task query parameters are invalid.');
  const limit = query.limit === undefined ? 20 : id(query.limit);
  if (limit > 50) throw new ValidationError('Limit must be between 1 and 50.');
  return { limit, ...(query.cursor === undefined ? {} : { cursor: id(query.cursor) }) };
}
function body<T>(schema: Parameters<typeof Value.Check>[0], value: unknown): T {
  if (!Value.Check(schema, value)) throw new ValidationError('The saved-task request is invalid.');
  return value as T;
}
function compatibilityQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some((key) => !['uploadIds', 'asOfDate', 'timeZone'].includes(key))) throw new ValidationError('Compatibility query parameters are invalid.');
  const raw = query.uploadIds;
  const pieces = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
  if (!pieces.length || pieces.length > 5 || pieces.some((value) => typeof value !== 'string')) throw new ValidationError('Choose the files to check.');
  const uploadIds = pieces.map(id);
  if (new Set(uploadIds).size !== uploadIds.length) throw new ValidationError('Choose each file only once.');
  if (query.asOfDate !== undefined && typeof query.asOfDate !== 'string') throw new ValidationError('The as-of date is invalid.');
  if (query.timeZone !== undefined && typeof query.timeZone !== 'string') throw new ValidationError('The time zone is invalid.');
  const parsed = { uploadIds, ...(typeof query.asOfDate === 'string' ? { asOfDate: query.asOfDate } : {}), ...(typeof query.timeZone === 'string' ? { timeZone: query.timeZone } : {}) };
  return body<TemplateCompatibilityQuery>(TemplateCompatibilityQuerySchema, parsed);
}

/** Saved-task creation, inspection, compatibility, execution, repair, and deletion. */
export function templateRoute(deps: TemplateRouteDependencies): Router {
  const router = Router();
  const guard = originGuard(deps.config);
  router.get('/api/executions/:id/save-preview', (req, res, next) => { try { res.json(deps.save.preview(id(req.params.id))); } catch (e) { next(e); } });
  router.post('/api/executions/:id/save', guard, (req, res, next) => { try {
    const result = deps.save.save(id(req.params.id), body<SaveExecutionRequest>(SaveExecutionRequestSchema, req.body));
    res.status(201).json({ template: presentTemplate(result.template), revision: presentRevisionSummary(result.revision) });
  } catch (e) { next(e); } });
  router.get('/api/templates/:id/compatibility', (req, res, next) => { try {
    const checked = deps.compatibility.checkStaged(id(req.params.id), compatibilityQuery(req.query));
    res.json({ report: checked.report, digest: checked.digest, asOf: checked.asOf });
  } catch (e) { next(e); } });
  router.get('/api/executions/:id/compatibility', (req, res, next) => { try {
    if (Object.keys(req.query).length) throw new ValidationError('This check does not accept query parameters.');
    const checked = deps.compatibility.checkExecution(id(req.params.id));
    res.json({ report: checked.report, digest: checked.digest, asOf: checked.asOf });
  } catch (e) { next(e); } });
  router.post('/api/templates/:id/runs', guard, (req, res, next) => { try {
    const created = deps.runs.start(id(req.params.id), body<StartTemplateRunRequest>(StartTemplateRunRequestSchema, req.body));
    res.status(201).json({ task: presentTask(created.task), execution: presentExecution(deps.executions.getById(created.execution.id) ?? created.execution) });
  } catch (e) { next(e); } });
  router.post('/api/executions/:id/replay', guard, (req, res, next) => { try {
    const run = deps.runs.replay(id(req.params.id));
    res.status(201).json({ execution: presentExecution(run) });
  } catch (e) { next(e); } });
  router.post('/api/templates/:id/repairs', guard, async (req, res, next) => { try {
    const created = await deps.repairs.startFromTemplate(id(req.params.id), body<StartTemplateRepairRequest>(StartTemplateRepairRequestSchema, req.body));
    res.status(201).json({ task: presentTask(created.task), execution: presentExecution(created.execution) });
  } catch (e) { next(e); } });
  router.post('/api/executions/:id/repair', guard, (req, res, next) => { try {
    const created = deps.repairs.repairExecution(id(req.params.id), body<RepairExecutionRequest>(RepairExecutionRequestSchema, req.body));
    res.status(201).json({ task: presentTask(created.task), execution: presentExecution(created.execution) });
  } catch (e) { next(e); } });
  router.get('/api/templates', (req, res, next) => { try {
    const listed = deps.templates.list(page(req.query));
    res.json({ ...listed, items: listed.items.map((item) => ({ id: item.id, name: item.name, currentRevisionNumber: item.currentRevisionNumber, revisionCount: item.revisionCount, runCount: item.runCount, lastRunAt: item.lastRunAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() })) });
  } catch (e) { next(e); } });
  router.get('/api/templates/:id/runs', (req, res, next) => { try {
    const templateId = id(req.params.id);
    if (!deps.templates.getById(templateId)) throw new TemplateNotFoundError(templateId);
    res.json(deps.history.listTemplateTasks(templateId, page(req.query)));
  } catch (e) { next(e); } });
  router.get('/api/templates/:id', (req, res, next) => { try {
    const templateId = id(req.params.id);
    const template = deps.templates.getById(templateId);
    if (!template) throw new TemplateNotFoundError(templateId);
    const revisions = deps.templates.listRevisions(templateId);
    res.json({ template: presentTemplate(template), currentRevision: presentRevision(revisions[0]!, deps.templates.listFiles(revisions[0]!.id)), revisions: revisions.map(presentRevisionSummary) });
  } catch (e) { next(e); } });
  router.get('/api/template-revisions/:id', (req, res, next) => { try {
    const revisionId = id(req.params.id);
    const revision = deps.templates.getRevision(revisionId);
    if (!revision) throw new TemplateRevisionNotFoundError(revisionId);
    const files = deps.templates.listFiles(revisionId);
    res.json({ revision: presentRevision(revision, files), files: files.map(presentRevisionFile) });
  } catch (e) { next(e); } });
  router.delete('/api/templates/:id', guard, (req, res, next) => { try {
    const templateId = id(req.params.id);
    const runsKept = deps.reuse.countTasksOfTemplate(templateId);
    res.json({ templateId, removed: deps.templates.delete(templateId), runsKept });
  } catch (e) { next(e); } });
  return router;
}
