import { Value } from '@sinclair/typebox/value';
import {
  CreateTaskRequestSchema,
  TaskNotFoundError,
  UPLOAD_LIMIT_DEFAULTS,
  ValidationError,
  type CreateTaskRequest,
  DisclosureConsentRequiredError,
} from '@automate/core';
import { Router } from 'express';
import type { ServerConfig } from '../config/env';
import {
  presentExecution,
  presentTask,
  type TaskSessionRegistry,
} from '../conversation/index';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { UploadRow } from '../db/repositories/upload-repository';
import type { UploadService } from '../ingestion/index';
import { originGuard } from '../middleware/origin-guard';
import type { DisclosureService } from '../disclosure/disclosure-service';
import type { PreflightService } from '../disclosure/preflight-service';
import type { DisclosureConsentRepository } from '../db/repositories/disclosure-consent-repository';

export interface TaskRouteDependencies {
  tasks: TaskRepository;
  executions: ExecutionRepository;
  registry: TaskSessionRegistry;
  config: ServerConfig;
  /** Attaches staged uploads inside task creation (FEAT-104). */
  uploads?: UploadService;
  disclosure?: DisclosureService;
  preflight?: PreflightService;
  consents?: DisclosureConsentRepository;
}
function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new ValidationError('The task id must be a positive integer.');
  return id;
}

/** Validate a create-task body, saying which part is wrong. */
function parseCreateTask(body: unknown): CreateTaskRequest {
  if (Value.Check(CreateTaskRequestSchema, body)) return body;
  const prompt = (body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt === 'string' && prompt.trim() !== '' && prompt.length <= 8000)
    throw new ValidationError(
      `Attach at most ${UPLOAD_LIMIT_DEFAULTS.maxFilesPerTask} files, each only once.`,
    );
  throw new ValidationError(
    'Enter a task description between 1 and 8000 characters.',
  );
}

/** Build task creation and detail endpoints. */
export function taskRoute(deps: TaskRouteDependencies): Router {
  const router = Router();
  router.post(
    '/api/tasks',
    originGuard(deps.config),
    async (request, response, next) => {
      try {
        const { prompt, uploadIds = [], disclosureAck, preflightDecisions = [] } = parseCreateTask(request.body);
        const uploads = deps.uploads;
        if (uploadIds.length > 0 && !uploads)
          throw new ValidationError('File attachments are not available.');
        let approved: ReturnType<DisclosureService['verifyAcknowledgement']> | undefined;
        let resolved: ReturnType<PreflightService['resolveDecisions']> = [];
        if (uploadIds.length > 0 && deps.disclosure) {
          if (!disclosureAck || !deps.preflight || !deps.consents) throw new DisclosureConsentRequiredError();
          approved = deps.disclosure.verifyAcknowledgement(disclosureAck.consentId, disclosureAck.payloadDigest, uploadIds);
          resolved = deps.preflight.resolveDecisions(uploadIds, preflightDecisions);
        }
        deps.registry.assertCapacity();
        let claimed: UploadRow[] = [];
        // Uploads are verified and claimed in the SAME transaction that creates
        // the task, so a task never starts with a half-attached input set.
        const created = deps.tasks.createWithExecution(
          prompt,
          uploadIds.length === 0 || !uploads
            ? undefined
            : (taskId, executionId) => {
                claimed = uploads.attachWithinTransaction(taskId, uploadIds);
                if (approved && deps.consents) deps.consents.attachToTask(approved.id, taskId);
                deps.preflight?.persist(executionId, resolved);
              },
        );
        // Files move only after commit; a failed move marks that upload, never the task.
        if (uploads && claimed.length > 0)
          await uploads.moveAttached(created.task.id, claimed);
        deps.registry.start(created.execution, created.task);
        response.status(201).json({
          task: presentTask(created.task),
          execution: presentExecution(
            deps.executions.getById(created.execution.id) ??
              created.execution,
          ),
        });
      } catch (cause) {
        next(cause);
      }
    },
  );
  router.get('/api/tasks/:taskId', (request, response, next) => {
    try {
      const id = parseId(String(request.params.taskId));
      const row = deps.tasks.getById(id);
      if (!row) throw new TaskNotFoundError(id);
      response.json({
        task: presentTask(row),
        executions: deps.executions.listByTask(id).map(presentExecution),
      });
    } catch (cause) {
      next(cause);
    }
  });
  return router;
}
