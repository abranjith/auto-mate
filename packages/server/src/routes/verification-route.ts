// ---------------------------------------------------------------------------
// Verification, approval, run, and review routes (FEAT-107 TASK-014).
//
// Every path param and body is validated against the TypeBox contracts from
// `packages/core`. The four state-changing routes carry FEAT-103's
// Origin/Host guard: `POST /approval` matters most, since without it a page in
// the developer's own browser could authorize generated code to run against
// their files. NO response contains an absolute path: findings are
// version-relative, runs name output files by filename only.
// ---------------------------------------------------------------------------

import { Value } from '@sinclair/typebox/value';
import { ApprovalRequestSchema, ReviewRequestSchema, ValidationError, VerificationNotFoundError, type ApprovalRequest, type ReviewRequest } from '@automate/core';
import { Router, type NextFunction, type Response } from 'express';
import type { ServerConfig } from '../config/env';
import type { ApprovalService } from '../verification/approval-service';
import type { ReviewService } from '../verification/review-service';
import type { RunIntentService } from '../verification/run-intent-service';
import type { VerificationService } from '../verification/verification-service';
import type { ScriptRunService } from '../execution/script-run-service';
import { originGuard } from '../middleware/origin-guard';

export interface VerificationRouteDependencies {
  readonly verification: VerificationService;
  readonly intents: RunIntentService;
  readonly approval: ApprovalService;
  readonly runs: ScriptRunService;
  readonly review: ReviewService;
  /** Throws when starting a new verification pass would exceed the concurrency cap. */
  readonly assertCapacity: () => void;
  readonly config: ServerConfig;
}

function idOf(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || String(raw) !== String(id)) throw new ValidationError('The execution id must be a positive integer.');
  return id;
}

/** Validate a body against its contract, with a plain-English error. */
function bodyOf<T>(schema: Parameters<typeof Value.Check>[0], body: unknown, message: string): T {
  if (!Value.Check(schema, body ?? {})) throw new ValidationError(message);
  return body as T;
}

/** Run a handler, sending its result or passing its error to the envelope middleware. */
function handle(response: Response, next: NextFunction, action: () => unknown | Promise<unknown>, status = 200): void {
  Promise.resolve().then(action).then((body) => { response.status(status).json(body); }, next);
}

/** Build the six FEAT-107 endpoints. */
export function verificationRoute(deps: VerificationRouteDependencies): Router {
  const router = Router();
  const guard = originGuard(deps.config);
  router.get('/api/executions/:id/verification', (request, response, next) => handle(response, next, () => {
    const id = idOf(request.params.id);
    const report = deps.verification.report(id);
    if (!report) throw new VerificationNotFoundError(id);
    return report;
  }));
  router.post('/api/executions/:id/verify', guard, (request, response, next) => handle(response, next, () => {
    const id = idOf(request.params.id);
    deps.assertCapacity();
    deps.verification.start(id, { fresh: true });
    return { status: 'verifying' };
  }, 202));
  router.get('/api/executions/:id/intent', (request, response, next) => handle(response, next, () => {
    const built = deps.intents.buildRunIntent(idOf(request.params.id));
    return { intent: built.intent, intentDigest: built.intentDigest };
  }));
  router.post('/api/executions/:id/approval', guard, (request, response, next) => handle(response, next, () => {
    const id = idOf(request.params.id);
    return deps.approval.decide(id, bodyOf<ApprovalRequest>(ApprovalRequestSchema, request.body, 'The decision must carry the intent digest you were shown, a decision of approved or cancelled, and whether you acknowledged the warnings.'));
  }));
  router.get('/api/executions/:id/run', (request, response, next) => handle(response, next, () => deps.runs.describe(idOf(request.params.id))));
  router.post('/api/executions/:id/review', guard, (request, response, next) => handle(response, next, () => {
    const id = idOf(request.params.id);
    return deps.review.review(id, bodyOf<ReviewRequest>(ReviewRequestSchema, request.body, 'A review is accepted or rejected, with feedback of at most 2,000 characters.'));
  }));
  return router;
}
