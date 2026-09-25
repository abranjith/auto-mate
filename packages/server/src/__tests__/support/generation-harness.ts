// Shared test support: the whole FEAT-106 generation stack wired against a
// temporary data root, a scripted agent, and a scripted Python runner. Not a
// test file: suites import it, so it registers no `describe` blocks.
import type { Server } from 'node:http';
import pino from 'pino';
import { createApp } from '../../app';
import type { ServerConfig } from '../../config/env';
import { GenerationService } from '../../generation/generation-service';
import { PreflightService } from '../../disclosure/preflight-service';
import type { ConversationEvent, PythonRunner } from '@automate/core';
import { FakeAgentProvider, type FakeAgentScript, type FakeAgentStep } from '../../agent/testing/fake-agent-provider';
import { TaskSessionRegistry } from '../../conversation/task-session-registry';
import { ConversationEventRepository } from '../../db/repositories/conversation-event-repository';
import { ExecutionRepository, type ExecutionRow } from '../../db/repositories/execution-repository';
import { TaskRepository, type TaskRow } from '../../db/repositories/task-repository';
import { UploadRepository, type UploadRow } from '../../db/repositories/upload-repository';
import { UploadProfileRepository } from '../../db/repositories/upload-profile-repository';
import { DisclosureConsentRepository } from '../../db/repositories/disclosure-consent-repository';
import { DisclosureTransmissionRepository } from '../../db/repositories/disclosure-transmission-repository';
import { ClarificationRepository } from '../../db/repositories/clarification-repository';
import { CodeVersionRepository } from '../../db/repositories/code-version-repository';
import { GenerationAttemptRepository } from '../../db/repositories/generation-attempt-repository';
import { SyntheticFixtureRepository } from '../../db/repositories/synthetic-fixture-repository';
import { ClarificationService, DisclosureRunStrategy, DisclosureService, createClarificationTool } from '../../disclosure/index';
import { FakePythonRunner, type FakePythonRun, type FakePythonRunnerOptions } from '../../execution/testing/fake-python-runner';
import { CodeGenerationRunStrategy } from '../../generation/code-generation-run-strategy';
import { CodeWorkspace } from '../../generation/code-workspace';
import { FixtureService } from '../../generation/fixture-service';
import { DEFAULT_BUDGET_LIMITS, type BudgetLimits } from '../../generation/generation-budget';
import { GenerationRuns } from '../../generation/generation-run';
import { GenerationTools } from '../../generation/generation-tools';
import { createTempStore, type TempStore } from './ingestion-fixtures';
import { sentinelCsv, stageProfiledUpload } from './generation-fixtures';

export const MAIN_PY = 'import os\nimport pandas as pd\n\ndef main():\n    frame = pd.read_csv(os.path.join(os.environ["AUTOMATE_INPUT_DIR"], "INPUT"))\n    frame.groupby("region")["amount"].sum().to_csv(os.path.join(os.environ["AUTOMATE_OUTPUT_DIR"], "totals.csv"))\n\nif __name__ == "__main__":\n    main()\n';
export const TEST_PY = 'from main import main\n\ndef test_main_runs():\n    main()\n';
const COMPLETED = { outcome: 'completed' as const, stopReason: 'stop', usage: { turns: 1 } };

/** Steps a scripted agent takes to write a script and its test. */
export function writeSteps(input: string, script = MAIN_PY): FakeAgentStep[] {
  return [
    { call: { tool: 'write_script', args: { path: 'main.py', content: script.replace('INPUT', input) } } },
    { call: { tool: 'write_test', args: { path: 'test_main.py', content: TEST_PY } } },
  ];
}
/** The step that finalizes `main.py` with a one-column input contract. */
export function finalizeStep(input: string, overrides: Record<string, unknown> = {}): FakeAgentStep {
  return { call: { tool: 'finalize_script', args: { entrypoint: 'main.py', summary: 'Totals sales by region.', declaredInputs: [{ fileRole: input, requiredColumns: [{ name: 'region', type: 'string' }] }], declaredOutputs: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Sales per region.' }], ...overrides } } };
}

export interface HarnessOptions {
  /** Build the agent's steps once the staged upload's stored filename is known. */
  readonly steps?: (upload: UploadRow | null) => readonly FakeAgentStep[];
  readonly scripts?: (upload: UploadRow | null) => readonly FakeAgentScript[];
  readonly pythonRuns?: readonly FakePythonRun[];
  readonly runnerOptions?: FakePythonRunnerOptions;
  /** A runner, or a factory given the temporary data paths (for a real runner over a fake spawn). */
  readonly runner?: PythonRunner | ((paths: TempStore['paths']) => PythonRunner);
  readonly limits?: Partial<BudgetLimits>;
  readonly scopeDiagnostics?: boolean;
  /** Files to attach; defaults to one sentinel CSV. Pass `[]` for a text-only task. */
  readonly files?: readonly { readonly name: string; readonly bytes: Buffer; readonly format: 'csv' | 'xlsx' }[];
  readonly prompt?: string;
}

/** Build the stack, stage and approve the files, and create the task — without starting it. */
export async function createGenerationHarness(options: HarnessOptions = {}) {
  const store: TempStore = createTempStore('automate-generation-');
  const logger = pino({ level: 'silent' });
  const c = store.connection;
  const repos = { tasks: new TaskRepository(c), executions: new ExecutionRepository(c), events: new ConversationEventRepository(c), uploads: new UploadRepository(c), profiles: new UploadProfileRepository(c), consents: new DisclosureConsentRepository(c), transmissions: new DisclosureTransmissionRepository(c), clarifications: new ClarificationRepository(c), versions: new CodeVersionRepository(c), attempts: new GenerationAttemptRepository(c), fixtures: new SyntheticFixtureRepository(c) };
  const model = { value: 'fake-model' };
  const configStore = { load: () => ({ provider: 'fake', model: model.value, auth: { mode: 'managed' as const } }) };
  const disclosure = new DisclosureService({ uploads: repos.uploads, profiles: repos.profiles, consents: repos.consents, configStore: configStore as never });
  const files = options.files ?? [{ name: 'sales.csv', bytes: Buffer.from(sentinelCsv()), format: 'csv' as const }];
  const staged: UploadRow[] = [];
  for (const file of files) staged.push(await stageProfiledUpload(c, store.paths, file));
  const consent = staged.length ? disclosure.grantConsent({ uploadIds: staged.map(({ id }) => id), payloadDigest: disclosure.buildPreview(staged.map(({ id }) => id)).digest, scopeDiagnostics: options.scopeDiagnostics ?? true }) : null;
  const created = repos.tasks.createWithExecution(options.prompt ?? 'Total the sales amount by region.', (taskId) => {
    for (const upload of staged) repos.uploads.attachToTask(upload.id, taskId, upload.filePath);
    if (consent) repos.consents.attachToTask(consent.id, taskId);
  });
  const uploads = repos.uploads.listByTask(created.task.id);
  const registryRef: { current?: TaskSessionRegistry } = {};
  const publish = (executionId: number, event: Parameters<TaskSessionRegistry['publish']>[1]) => registryRef.current!.publish(executionId, event);
  const clarificationService = new ClarificationService({ clarifications: repos.clarifications, executions: repos.executions, events: repos.events, maxAgentClarifications: 3, maxWaitingExecutions: 5, waitingCount: () => registryRef.current?.waitingCount() ?? 0, publish });
  const inner = new DisclosureRunStrategy({ disclosure, transmissions: repos.transmissions, uploads: repos.uploads, clarifications: repos.clarifications, executions: repos.executions, clarificationTool: createClarificationTool(clarificationService), publish });
  const runner = typeof options.runner === 'function' ? options.runner(store.paths) : options.runner ?? new FakePythonRunner(options.pythonRuns ?? [], options.runnerOptions);
  const runs = new GenerationRuns();
  const workspace = new CodeWorkspace({ versions: repos.versions, attempts: repos.attempts, paths: store.paths, logger });
  const fixtureService = new FixtureService({ uploads: repos.uploads, profiles: repos.profiles, fixtures: repos.fixtures, paths: store.paths, logger });
  const tools = new GenerationTools({ workspace, versions: repos.versions, attempts: repos.attempts, executions: repos.executions, runs, runner, consent: disclosure, diagnostics: inner, transmissions: repos.transmissions, fixturesDir: (id) => fixtureService.fixturesDir(id), publish, logger, uploads: repos.uploads, profiles: repos.profiles });
  const limits = { ...DEFAULT_BUDGET_LIMITS, ...options.limits };
  const strategy = new CodeGenerationRunStrategy({ inner, disclosure, uploads: repos.uploads, profiles: repos.profiles, executions: repos.executions, versions: repos.versions, attempts: repos.attempts, fixtures: fixtureService, runs, tools, logger, limits, platform: 'linux', pythonVersion: () => '3.12.4' });
  const upload = uploads[0] ?? null;
  const scripts = options.scripts?.(upload) ?? [{ events: [], steps: options.steps?.(upload) ?? [], result: COMPLETED }];
  const provider = new FakeAgentProvider(scripts);
  const registry = new TaskSessionRegistry({ provider, executions: repos.executions, events: repos.events, strategy, paths: store.paths, model: () => ({ provider: 'fake', id: model.value }), auth: () => ({ mode: 'managed' }), logger, maxConcurrentExecutions: 5, clarifications: clarificationService, onInterrupted: (id) => repos.attempts.abortRunning(id) });
  registryRef.current = registry;
  const preflight = new PreflightService(repos.profiles, repos.clarifications);
  const service = new GenerationService({ tasks: repos.tasks, executions: repos.executions, versions: repos.versions, attempts: repos.attempts, fixtures: repos.fixtures, fixtureService, transmissions: repos.transmissions, uploads: repos.uploads, disclosure, preflight, registry, logger, limits });
  const servers: Server[] = [];
  return {
    service, preflight,
    /** Serve the real app over HTTP on a random loopback port. */
    async serve(): Promise<{ base: string; config: ServerConfig }> {
      const config: ServerConfig = { host: '127.0.0.1', port: 0, logLevel: 'silent', maxConcurrentExecutions: 5, allowedOrigins: [], nodeEnv: 'test' };
      const app = createApp({ logger, dataRoot: store.root, version: 'test', paths: store.paths, getSchemaVersion: () => '5', conversation: { tasks: repos.tasks, executions: repos.executions, events: repos.events, registry }, serverConfig: config, generation: { service } });
      const server = app.listen(0, '127.0.0.1');
      servers.push(server);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no address');
      config.port = address.port;
      return { base: `http://127.0.0.1:${address.port}`, config };
    },
    store, repos, disclosure, consent, inner, runner, runs, workspace, fixtureService, tools, strategy, provider, registry, model, upload, uploads, limits, clarificationService,
    task: created.task as TaskRow,
    execution: created.execution as ExecutionRow,
    /** Start the task's first execution and wait for it to settle. */
    run(execution: ExecutionRow = created.execution): Promise<ExecutionRow> { return registry.start(execution, created.task).settled; },
    transcript(executionId = created.execution.id): ConversationEvent[] { return repos.events.listAfter(executionId, 0, 1000).events; },
    async dispose(): Promise<void> {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      store.dispose();
    },
  };
}
export type GenerationHarness = Awaited<ReturnType<typeof createGenerationHarness>>;
export { COMPLETED };
