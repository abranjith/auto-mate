import { Value } from '@sinclair/typebox/value';
import { RuntimePrepareRequestSchema, RuntimeStatusResponseSchema, ValidationError, describeRuntimeCapabilities, type RuntimePrepareRequest } from '@automate/core';
import { Router } from 'express';
import type { ServerConfig } from '../config/env';
import type { RuntimeProvisioner } from '../execution/runtime-provisioner';
import { originGuard } from '../middleware/origin-guard';
import { PINNED_PYTHON_VERSION } from '../execution/dependency-policy';

export interface RuntimeRouteDependencies {
  readonly provisioner: RuntimeProvisioner;
  readonly config: ServerConfig;
  readonly platform?: NodeJS.Platform;
}

/** Read runtime state or ask the application to prepare a locked environment. */
export function runtimeRoute(deps: RuntimeRouteDependencies): Router {
  const router = Router();
  router.get('/api/runtime', (_request, response) => {
    const body = { pinnedPythonVersion: PINNED_PYTHON_VERSION, script: deps.provisioner.getReadiness('script'), verify: deps.provisioner.getReadiness('verify'), capabilities: describeRuntimeCapabilities(deps.platform ?? process.platform) };
    if (!Value.Check(RuntimeStatusResponseSchema, body)) throw new Error('Runtime response does not match its contract.');
    response.json(body);
  });
  router.post('/api/runtime/prepare', originGuard(deps.config), (request, response, next) => {
    if (!Value.Check(RuntimePrepareRequestSchema, request.body)) { next(new ValidationError('Choose script or verify as the Python environment to prepare.')); return; }
    const body = request.body as RuntimePrepareRequest;
    const controller = new AbortController();
    void deps.provisioner.ensureRuntime(body.kind, controller.signal).then(() => response.json({ kind: body.kind, readiness: deps.provisioner.getReadiness(body.kind) }), next);
  });
  return router;
}
