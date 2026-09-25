// ---------------------------------------------------------------------------
// `CodeGenerationRunStrategy` (FEAT-106 TASK-010).
//
// It WRAPS FEAT-105's `DisclosureRunStrategy`; it does not replace it. The
// inner strategy still verifies consent, renders the approved context from the
// consent snapshot, records the one `context` transmission receipt, and owns
// the single `assemblePromptContext` call — this strategy only adds the code
// contract (as application text) and a retry's guidance (as the person's
// words) to that same call, then registers the four generation tools beside
// `request_clarification`.
//
// Order matters: consent is verified BEFORE any fixture is written, so a
// revoked or stale approval stops the run with nothing on disk and the
// provider never opened. Text-only tasks, with nothing to generate against,
// pass straight through to the inner strategy.
// ---------------------------------------------------------------------------

import { buildDisclosurePayload, renderCodeContract, type ContractInputFile, type FileFormat } from '@automate/core';
import type { Logger } from 'pino';
import type { BuiltRun, RunStrategy } from '../conversation/run-strategy';
import type { CodeVersionRepository } from '../db/repositories/code-version-repository';
import type { ExecutionRepository, ExecutionRow } from '../db/repositories/execution-repository';
import type { GenerationAttemptRepository } from '../db/repositories/generation-attempt-repository';
import type { TaskRow } from '../db/repositories/task-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';
import type { UploadRepository, UploadRow } from '../db/repositories/upload-repository';
import type { DisclosureRunStrategy } from '../disclosure/disclosure-run-strategy';
import type { DisclosureService } from '../disclosure/disclosure-service';
import { SCRIPT_DEPENDENCY_SET } from '../execution/dependency-policy';
import type { FixtureService } from './fixture-service';
import { DEFAULT_BUDGET_LIMITS, GenerationBudget, type BudgetLimits } from './generation-budget';
import { GenerationLifecycle } from './generation-lifecycle';
import { GenerationRun, type GenerationRuns } from './generation-run';
import type { GenerationTools } from './generation-tools';

export interface CodeGenerationRunStrategyDependencies {
  readonly inner: DisclosureRunStrategy;
  readonly disclosure: DisclosureService;
  readonly uploads: UploadRepository;
  readonly profiles: UploadProfileRepository;
  readonly executions: ExecutionRepository;
  readonly versions: CodeVersionRepository;
  readonly attempts: GenerationAttemptRepository;
  readonly fixtures: FixtureService;
  readonly runs: GenerationRuns;
  readonly tools: GenerationTools;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly limits?: BudgetLimits;
  readonly platform?: NodeJS.Platform;
  /** The Python version last probed, if known; the contract names it when it can. */
  readonly pythonVersion?: () => string | null;
  /** FEAT-107: finalized runs hand off to verification (`generating → verifying`) rather than completing. */
  readonly handOffToVerification?: boolean;
}

/** The role, the tools, and the clarification rule, as the system prompt. */
export const GENERATION_SYSTEM_PROMPT = [
  'You are Auto-Mate\'s code generation agent. You turn a person\'s plain-English request about their file into a Python script, test it, and hand it back.',
  'You have exactly five tools: write_script, write_test, run_tests, finalize_script, and request_clarification. You cannot read files, run commands, or reach the network yourself; the application stores what you write and runs your tests for you against synthetic data.',
  'Follow the CODE CONTRACT in the request exactly.',
  'Ask through request_clarification only when ambiguity changes meaning or risks data loss. State a rationale and a proposed default. Cosmetic choices must use a disclosed default.',
].join('\n');

/** Approved context plus the code contract, the fixtures, and the four generation tools. */
export class CodeGenerationRunStrategy implements RunStrategy {
  constructor(private readonly deps: CodeGenerationRunStrategyDependencies) {}

  async buildRun(task: TaskRow, execution: ExecutionRow): Promise<BuiltRun> {
    const uploads = this.deps.uploads.listByTask(task.id);
    if (uploads.length === 0) return this.deps.inner.buildRun(task, execution, { guidance: execution.guidance });
    // Verify before writing anything: a revoked or stale approval leaves no fixture behind.
    this.deps.disclosure.verifyForTransmission(task.id, 'context');
    const budget = new GenerationBudget({ executionId: execution.id, attempts: this.deps.attempts, executions: this.deps.executions, limits: this.deps.limits ?? DEFAULT_BUDGET_LIMITS });
    const run = new GenerationRun(execution.id, task.id, budget);
    await this.deps.fixtures.materializeFixtures(execution.id, uploads.map(({ id }) => id), run.signal);
    const contract = renderCodeContract({ platform: this.deps.platform ?? process.platform, pythonVersion: this.deps.pythonVersion?.() ?? null, dependencies: SCRIPT_DEPENDENCY_SET.map(({ name }) => name), inputFiles: uploads.map((upload) => this.inputFile(upload)), attemptLimit: budget.limits.maxAttempts });
    const appText = execution.guidance ? [contract, 'The person reviewed an earlier attempt that did not succeed and added guidance; it follows their original request above. Use it.'] : [contract];
    const built = this.deps.inner.buildRun(task, execution, { appText, guidance: execution.guidance });
    this.deps.runs.open(run);
    const lifecycle = new GenerationLifecycle({ run, runs: this.deps.runs, versions: this.deps.versions, attempts: this.deps.attempts, logger: this.deps.logger, ...(this.deps.platform ? { platform: this.deps.platform } : {}), ...(this.deps.handOffToVerification ? { handOffToVerification: true } : {}) });
    return { ...built, systemPrompt: GENERATION_SYSTEM_PROMPT, customTools: [...built.customTools, ...this.deps.tools.all()], lifecycle };
  }

  /** How the contract names one input: its stored filename and, for a workbook, its disclosed sheets in order. */
  private inputFile(upload: UploadRow): ContractInputFile {
    const format = upload.format as FileFormat;
    const source = format === 'xlsx' ? this.deps.profiles.getDisclosureSource(upload.id) : undefined;
    const sheets = source ? buildDisclosurePayload(source.upload, source.profiles).tables.flatMap(({ sheetName }) => (sheetName === null ? [] : [sheetName])) : [];
    return { filename: upload.storedFilename, format, sheets };
  }
}
