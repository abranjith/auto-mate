// Composition of the FEAT-107 stack: the checker environment, the runtime
// probe, and the verification, intent, approval, run, and review services.
// The registry is supplied lazily because it is built from the generation
// strategy, and the retry comes from FEAT-106's generation service.
//
// Nothing composed here opens a provider session: FEAT-107 sends nothing to a
// model.

import { AutoMateError, ERROR_CODES, type PythonRunner, type UnnumberedConversationEvent } from '@automate/core';
import type { Logger } from 'pino';
import type { AppPaths } from '../config/app-paths';
import type { GenerationConfig, VerificationConfig } from '../config/env';
import type { TaskSessionRegistry } from '../conversation/task-session-registry';
import type { DatabaseConnection } from '../db/client';
import { ApprovalRepository } from '../db/repositories/approval-repository';
import type { CodeVersionRepository } from '../db/repositories/code-version-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import { ScriptRunRepository } from '../db/repositories/script-run-repository';
import { SyntheticFixtureRepository } from '../db/repositories/synthetic-fixture-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository } from '../db/repositories/upload-repository';
import { VerificationRepository } from '../db/repositories/verification-repository';
import { ScriptRunService } from '../execution/script-run-service';
import { RuntimeProvisioner } from '../execution/runtime-provisioner';
import { RuntimeEnvironmentRepository } from '../db/repositories/runtime-environment-repository';
import type { CodeWorkspace } from '../generation/code-workspace';
import type { FixtureService } from '../generation/fixture-service';
import type { GenerationService } from '../generation/generation-service';
import { ApprovalService } from './approval-service';
import { ExecutionStateWriter } from './execution-state-writer';
import { ReviewService } from './review-service';
import { RunIntentService } from './run-intent-service';
import { UvRuntimeProbe } from './runtime-probe';
import { VerificationService } from './verification-service';
import { VerifyEnvironment } from './verify-env';

export interface VerificationStackDependencies {
  readonly connection: DatabaseConnection;
  readonly paths: AppPaths;
  readonly logger: Logger;
  readonly config: VerificationConfig;
  readonly generationConfig: Pick<GenerationConfig, 'testRunTimeoutMs' | 'uvSyncTimeoutMs'>;
  readonly runner: PythonRunner;
  readonly provisioner?: RuntimeProvisioner;
  readonly executions: ExecutionRepository;
  readonly versions: CodeVersionRepository;
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly workspace: Pick<CodeWorkspace, 'project'>;
  readonly fixtureService: Pick<FixtureService, 'rebuild'>;
  readonly generation: Pick<GenerationService, 'retry'>;
  readonly registry: () => TaskSessionRegistry;
}

/**
 * Build the verification stack.
 * @returns The services the routes use, the repositories the registry's restart hook tidies, and the hand-off entry point.
 */
export function createVerificationStack(deps: VerificationStackDependencies) {
  const { connection, paths, logger, config } = deps;
  const verifications = new VerificationRepository(connection);
  const approvals = new ApprovalRepository(connection);
  const scriptRuns = new ScriptRunRepository(connection);
  const publish = (executionId: number, event: UnnumberedConversationEvent) => deps.registry().publish(executionId, event);
  const track = (executionId: number, job: Parameters<TaskSessionRegistry['track']>[1]) => deps.registry().track(executionId, job);
  const state = new ExecutionStateWriter(deps.executions, publish);
  const provisioner = deps.provisioner ?? new RuntimeProvisioner({ scriptEnvDir: paths.envDir, verifyEnvDir: paths.verifyEnvDir, environments: new RuntimeEnvironmentRepository(connection) });
  const verifyEnv = new VerifyEnvironment({ verifyEnvDir: paths.verifyEnvDir, provisioner });
  const probe = new UvRuntimeProbe({ runner: deps.runner, workingDir: paths.verifyEnvDir, checkerVersions: async (signal) => { await verifyEnv.ensureVerifyEnvironment(signal); return verifyEnv.probeCheckerVersions(signal); } });
  const checkers = { ensureVerifyEnvironment: (signal: AbortSignal) => verifyEnv.ensureVerifyEnvironment(signal), runTool: verifyEnv.runTool.bind(verifyEnv), bandit: { configPath: verifyEnv.banditConfigPath, iniPath: verifyEnv.banditIniPath } };
  const pass = { integrity: { project: (id: number) => deps.workspace.project(id), fixtures: deps.fixtureService }, checkers, runner: deps.runner, limits: { lintTimeoutMs: config.lintTimeoutMs, securityTimeoutMs: config.securityTimeoutMs, testRunTimeoutMs: deps.generationConfig.testRunTimeoutMs } };
  const verification = new VerificationService({ executions: deps.executions, versions: deps.versions, verifications, fixtures: new SyntheticFixtureRepository(connection), uploads: deps.uploads, profiles: deps.profiles, probe, pass, paths, state, publish, track, logger, timeoutMs: config.verificationTimeoutMs });
  const intents = new RunIntentService({ executions: deps.executions, versions: deps.versions, verifications, uploads: deps.uploads, profiles: deps.profiles });
  const runs = new ScriptRunService({ executions: deps.executions, versions: deps.versions, uploads: deps.uploads, scriptRuns, runner: deps.runner, probe, provisioner, project: (id) => deps.workspace.project(id), paths, state, publish, track, logger, timeoutMs: config.scriptRunTimeoutMs, maxOutputBytes: config.maxRunOutputBytes });
  const approval = new ApprovalService({ executions: deps.executions, approvals, intents, probe, state, publish, assertCapacity: () => deps.registry().assertCapacity(), onApproved: (id) => { runs.start(id); }, reverify: (id) => { verification.start(id); }, logger });
  const review = new ReviewService({ executions: deps.executions, state, publish, retry: (id, feedback) => deps.generation.retry(id, feedback, 'feedback'), logger, maxFeedbackChars: config.maxReviewFeedbackChars });
  return {
    verification, intents, approval, runs, review, verifications, scriptRuns,
    /** The registry's hand-off: a finalized generation starts its verification pass. */
    onHandOff: (executionId: number) => {
      try { verification.start(executionId); }
      catch (cause) {
        // Never leave a handed-off run in `verifying` with nothing running.
        const error = cause instanceof AutoMateError ? { code: cause.code, message: cause.message } : { code: ERROR_CODES.INTERNAL_ERROR, message: 'The code could not be checked. Try again.' };
        logger.warn({ executionId, code: error.code }, 'verification could not start after generation');
        state.settle(executionId, 'failed', error, true);
      }
    },
    /** The registry's restart/drain hook: settle any pass or run still marked running. */
    onInterrupted: (executionId: number) => { verifications.abortRunning(executionId); scriptRuns.abortRunning(executionId); },
  };
}
export type VerificationStack = ReturnType<typeof createVerificationStack>;
