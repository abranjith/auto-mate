// Composition of the FEAT-106 generation stack. The registry is supplied
// lazily because it is built from the strategy this function returns.

import type { PythonRunner, UnnumberedConversationEvent } from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import type { GenerationConfig } from '../config/env';
import type { TaskSessionRegistry } from '../conversation/task-session-registry';
import type { DatabaseConnection } from '../db/client';
import { CodeVersionRepository } from '../db/repositories/code-version-repository';
import type { DisclosureTransmissionRepository } from '../db/repositories/disclosure-transmission-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import { GenerationAttemptRepository } from '../db/repositories/generation-attempt-repository';
import { SyntheticFixtureRepository } from '../db/repositories/synthetic-fixture-repository';
import type { TaskRepository } from '../db/repositories/task-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import type { DisclosureRunStrategy } from '../disclosure/disclosure-run-strategy';
import type { DisclosureService } from '../disclosure/disclosure-service';
import type { PreflightService } from '../disclosure/preflight-service';
import { CodeGenerationRunStrategy } from './code-generation-run-strategy';
import { CodeWorkspace } from './code-workspace';
import { FixtureService } from './fixture-service';
import { GenerationRuns } from './generation-run';
import { GenerationService } from './generation-service';
import { GenerationTools } from './generation-tools';

export interface GenerationStackDependencies {
  readonly connection: DatabaseConnection;
  readonly paths: AppPaths;
  readonly logger: Logger;
  readonly config: GenerationConfig;
  readonly runner: PythonRunner;
  readonly disclosure: DisclosureService;
  readonly inner: DisclosureRunStrategy;
  readonly preflight: PreflightService;
  readonly tasks: TaskRepository;
  readonly executions: ExecutionRepository;
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly transmissions: DisclosureTransmissionRepository;
  readonly publish: (executionId: number, event: UnnumberedConversationEvent) => void;
  readonly registry: () => TaskSessionRegistry;
  readonly pythonVersion?: () => string | null;
}

/**
 * Build the generation strategy, its tools, and the read-model service.
 *
 * @returns The strategy to hand the session registry, the service the routes use, and the attempts repository the registry's restart hook tidies.
 */
export function createGenerationStack(deps: GenerationStackDependencies) {
  const { connection, logger, config } = deps;
  const versions = new CodeVersionRepository(connection);
  const attempts = new GenerationAttemptRepository(connection);
  const fixtures = new SyntheticFixtureRepository(connection);
  const runs = new GenerationRuns();
  const workspace = new CodeWorkspace({ versions, attempts, paths: deps.paths, logger, maxScriptBytes: config.maxScriptBytes });
  const fixtureService = new FixtureService({ uploads: deps.uploads, profiles: deps.profiles, fixtures, paths: deps.paths, logger, rowCount: config.fixtureRowCount });
  const tools = new GenerationTools({ workspace, versions, attempts, executions: deps.executions, runs, runner: deps.runner, consent: deps.disclosure, diagnostics: deps.inner, transmissions: deps.transmissions, fixturesDir: (id) => fixtureService.fixturesDir(id), publish: deps.publish, logger, uploads: deps.uploads, profiles: deps.profiles, testRunTimeoutMs: config.testRunTimeoutMs, maxScriptBytes: config.maxScriptBytes });
  const strategy = new CodeGenerationRunStrategy({ inner: deps.inner, disclosure: deps.disclosure, uploads: deps.uploads, profiles: deps.profiles, executions: deps.executions, versions, attempts, fixtures: fixtureService, runs, tools, logger, limits: { maxAttempts: config.maxAttempts, timeoutMs: config.timeoutMs, maxCostUsd: config.maxCostUsd }, ...(deps.pythonVersion ? { pythonVersion: deps.pythonVersion } : {}) });
  const registry = { assertCapacity: () => deps.registry().assertCapacity(), start: (...args: Parameters<TaskSessionRegistry['start']>) => deps.registry().start(...args) };
  const service = new GenerationService({ tasks: deps.tasks, executions: deps.executions, versions, attempts, fixtures, fixtureService, transmissions: deps.transmissions, uploads: deps.uploads, disclosure: deps.disclosure, preflight: deps.preflight, registry, logger, limits: { maxAttempts: config.maxAttempts, timeoutMs: config.timeoutMs } });
  return { strategy, service, runs, attempts, versions };
}
export type GenerationStack = ReturnType<typeof createGenerationStack>;
