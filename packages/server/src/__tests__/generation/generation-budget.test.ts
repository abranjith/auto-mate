import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenerationBudget, type BudgetLimits } from '../../generation/generation-budget';
import { CodeVersionRepository } from '../../db/repositories/code-version-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { GenerationAttemptRepository } from '../../db/repositories/generation-attempt-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { createTempStore, type TempStore } from '../support/ingestion-fixtures';
import { createGenerationHarness, writeSteps, type GenerationHarness } from '../support/generation-harness';
import { lockedUvRunner } from '../support/locked-uv-runner';

let store: TempStore;
beforeEach(() => { store = createTempStore('automate-budget-'); });
afterEach(() => store.dispose());

function budgetFor(limits: Partial<BudgetLimits> = {}, clock?: () => number) {
  const tasks = new TaskRepository(store.connection);
  const executions = new ExecutionRepository(store.connection);
  const attempts = new GenerationAttemptRepository(store.connection);
  const execution = tasks.createWithExecution('Summarize').execution;
  executions.markStarted(execution.id);
  const make = () => new GenerationBudget({ executionId: execution.id, attempts, executions, limits: { maxAttempts: 3, timeoutMs: 600_000, maxCostUsd: 0, ...limits }, ...(clock ? { clock } : {}) });
  return { make, attempts, executionId: execution.id, executions };
}
function recordAttempt(attempts: GenerationAttemptRepository, executionId: number, attempt: number) {
  const versions = new CodeVersionRepository(store.connection);
  const draft = versions.openDraft(executionId, attempt);
  versions.putFile(draft.id, { path: 'main.py', role: 'script', content: `v${attempt}` });
  const sealed = versions.seal(draft.id);
  attempts.settle(attempts.open({ executionId, codeVersionId: sealed.id, attempt, callId: null }).id, { status: 'failed' });
}

describe('GenerationBudget', () => {
  it('grants three attempts and refuses the fourth, reading the count from the database', () => {
    const { make, attempts, executionId } = budgetFor();
    const budget = make();
    for (const attempt of [1, 2, 3]) {
      expect(budget.claimAttempt()).toMatchObject({ granted: true, remainingAfter: 3 - attempt });
      recordAttempt(attempts, executionId, attempt);
    }
    expect(budget.claimAttempt()).toEqual({ granted: false, reason: 'attempt_limit', used: 3 });
  });

  it('still refuses after a restart, which an in-memory counter would not', () => {
    const { make, attempts, executionId } = budgetFor();
    for (const attempt of [1, 2, 3]) recordAttempt(attempts, executionId, attempt);
    expect(make().claimAttempt()).toMatchObject({ granted: false, reason: 'attempt_limit' });
  });

  it('does not count refusals against the limit', () => {
    const { make, attempts, executionId } = budgetFor({ maxAttempts: 1 });
    attempts.refuse({ executionId, attempt: 1, callId: null, reason: 'runtime_unavailable' });
    expect(make().claimAttempt().granted).toBe(true);
  });

  it('refuses time_limit once the injected clock passes the deadline, measured from the persisted start', () => {
    let now = Date.now() + 1_000;
    const { make, executions, executionId } = budgetFor({ timeoutMs: 60_000 }, () => now);
    const budget = make();
    expect(budget.claimAttempt().granted).toBe(true);
    now = executions.getById(executionId)!.startedAt!.getTime() + 60_001;
    expect(budget.claimAttempt()).toMatchObject({ granted: false, reason: 'time_limit' });
    expect(budget.stopReason()?.code).toBe('GENERATION_TIMEOUT');
    expect(budget.timeoutError().message).toContain('past its limit of 1 minute');
  });

  it('refuses cost_limit once reported spend passes an enabled cap', () => {
    const budget = budgetFor({ maxCostUsd: 0.5 }).make();
    budget.recordUsage({ turns: 1, costUsd: 0.3 });
    expect(budget.claimAttempt().granted).toBe(true);
    budget.recordUsage({ turns: 1, costUsd: 0.25 });
    expect(budget.claimAttempt()).toMatchObject({ granted: false, reason: 'cost_limit' });
    expect(budget.stopReason()?.message).toContain('$0.5500');
  });

  it('never refuses for cost with the cap at 0, however much is spent — visibly off', () => {
    const budget = budgetFor({ maxCostUsd: 0 }).make();
    budget.recordUsage({ turns: 1, costUsd: 1_000 });
    expect(budget.claimAttempt().granted).toBe(true);
    expect(budget.stopReason()).toBeNull();
  });

  it('never materializes a zero cost the provider did not report', () => {
    const budget = budgetFor({ maxCostUsd: 0.01 }).make();
    budget.recordUsage({ turns: 1, inputTokens: 100, outputTokens: 20 });
    expect(budget.spentUsd()).toBeNull();
    expect(budget.tokens()).toEqual({ input: 100, output: 20 });
    expect(budget.claimAttempt().granted).toBe(true);
    budget.recordUsage({ turns: 1, costUsd: 0 });
    expect(budget.spentUsd()).toBe(0);
  });

  it('does not count time spent waiting for a person against the wall clock', () => {
    let now = 0;
    const { make, executions, executionId } = budgetFor({ timeoutMs: 60_000 }, () => now);
    const start = executions.getById(executionId)!.startedAt!.getTime();
    now = start + 10_000;
    const budget = make();
    budget.pause();
    now = start + 600_000;
    expect(budget.paused).toBe(true);
    expect(budget.elapsedMs()).toBe(10_000);
    expect(budget.stopReason()).toBeNull();
    budget.resume();
    budget.resume();
    expect(budget.timeRemainingMs()).toBe(50_000);
    now = start + 600_000 + 50_001;
    expect(budget.stopReason()?.code).toBe('GENERATION_TIMEOUT');
  });

  it('keeps two executions\' budgets independent', () => {
    const first = budgetFor({ maxAttempts: 1 });
    const second = budgetFor({ maxAttempts: 1 });
    recordAttempt(first.attempts, first.executionId, 1);
    expect(first.make().claimAttempt().granted).toBe(false);
    expect(second.make().claimAttempt().granted).toBe(true);
  });
});

describe('limits and cancellation across every leg', () => {
  const harnesses: GenerationHarness[] = [];
  afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });
  const track = <T extends GenerationHarness>(harness: T) => { harnesses.push(harness); return harness; };
  const never = new Promise<void>(() => undefined);

  it('treats the attempt limit as configuration: at 1, a second run_tests is refused', async () => {
    const harness = track(await createGenerationHarness({ limits: { maxAttempts: 1 }, pythonRuns: [{ result: { outcome: 'failed', exitCode: 1, stdout: '1 failed in 0.1s' } }], steps: (upload) => [...writeSteps(upload!.storedFilename), { call: { tool: 'run_tests', args: {} } }, ...writeSteps(upload!.storedFilename), { call: { tool: 'run_tests', args: {} } }] }));
    await harness.run();
    expect(harness.repos.attempts.listByExecution(harness.execution.id).map(({ status, refusalReason }) => [status, refusalReason])).toEqual([['failed', null], ['refused', 'attempt_limit']]);
  });

  it('aborts mid-turn when the wall clock expires, settling failed with both figures and keeping the attempts', async () => {
    const harness = track(await createGenerationHarness({ limits: { timeoutMs: 1_000 }, pythonRuns: [{ result: { outcome: 'failed', exitCode: 1, stdout: '1 failed in 0.1s' } }], steps: (upload) => [...writeSteps(upload!.storedFilename), { call: { tool: 'run_tests', args: {} } }, { until: never }] }));
    const row = await harness.run();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'GENERATION_TIMEOUT' });
    expect(row.errorMessage).toMatch(/ran for \d+ seconds?, past its limit of 1 second/);
    expect(harness.repos.attempts.listByExecution(harness.execution.id)).toHaveLength(1);
    expect(harness.repos.versions.listByExecution(harness.execution.id)[0]!.status).toBe('tested_fail');
    expect(harness.provider.sessions[0]!.abortCount).toBe(1);
    expect(harness.transcript().filter(({ type }) => type === 'generation_settled')).toMatchObject([{ outcome: 'timed_out' }]);
  });

  /** A locked runner over fake spawn, so tree kills are observable without starting a process. */
  const uvRunner = lockedUvRunner;

  it('kills the pytest process tree when a person aborts during a test run, settling the attempt and the execution aborted', async () => {
    let built!: ReturnType<typeof uvRunner>;
    const harness = track(await createGenerationHarness({ runner: (paths, connection) => (built = uvRunner(paths, connection, (_, args) => (args[0] === '--version' ? { stdout: 'uv 0.11.32\n' } : args[0] === 'run' ? { hang: true } : { exitCode: 0 }))).runner, steps: (upload) => [...writeSteps(upload!.storedFilename), { call: { tool: 'run_tests', args: {} } }] }));
    writeFileSync(path.join(harness.store.paths.envDir, 'uv.lock'), 'lock');
    const settled = harness.run();
    await waitFor(() => built.fake.calls.some(({ args }) => args.includes('pytest')));
    await harness.registry.abort(harness.execution.id);
    expect((await settled).status).toBe('aborted');
    const pytest = built.fake.calls.find(({ args }) => args.includes('pytest'))!;
    expect(built.fake.calls.some(({ command, args }) => command === 'taskkill' && args.join(' ') === `/pid ${pytest.pid} /T /F`)).toBe(true);
    expect(harness.repos.attempts.listByExecution(harness.execution.id)).toMatchObject([{ status: 'aborted' }]);
    expect(harness.transcript().filter(({ type }) => type === 'generation_settled')).toMatchObject([{ outcome: 'aborted' }]);
  });

  it('cancels an in-flight uv sync when a person aborts during environment preparation', async () => {
    let built!: ReturnType<typeof uvRunner>;
    const harness = track(await createGenerationHarness({ runner: (paths, connection) => (built = uvRunner(paths, connection, (_, args) => (args[0] === '--version' ? { stdout: 'uv 0.11.32\n' } : args[0] === 'sync' ? { hang: true } : { exitCode: 0 }))).runner, steps: (upload) => [...writeSteps(upload!.storedFilename), { call: { tool: 'run_tests', args: {} } }] }));
    const settled = harness.run();
    await waitFor(() => built.fake.calls.some(({ args }) => args[0] === 'sync'));
    await harness.registry.abort(harness.execution.id);
    expect((await settled).status).toBe('aborted');
    expect(built.fake.calls.some(({ command }) => command === 'taskkill')).toBe(true);
    expect(built.fake.calls.some(({ args }) => args[0] === 'run')).toBe(false);
    expect(harness.repos.attempts.listByExecution(harness.execution.id)).toEqual([]);
  });

  it('cancels a pending clarification first, then application work, then the provider', async () => {
    const harness = track(await createGenerationHarness({ steps: () => [{ call: { tool: 'request_clarification', args: { questions: [{ question: 'Which total?', rationale: 'It changes the meaning.', impact: 'meaning', proposedDefault: 'sum' }] } } }] }));
    const order: string[] = [];
    const cancelClarification = harness.clarificationService.cancelForExecution.bind(harness.clarificationService);
    harness.clarificationService.cancelForExecution = (id) => { order.push('clarification'); cancelClarification(id); };
    const settled = harness.run();
    await waitFor(() => harness.repos.executions.getById(harness.execution.id)?.status === 'waiting');
    const run = harness.runs.get(harness.execution.id)!;
    const cancelRun = run.cancel.bind(run);
    run.cancel = () => { order.push('application'); cancelRun(); };
    const session = harness.provider.sessions[0]!;
    const abortProvider = session.abort.bind(session);
    session.abort = () => { order.push('provider'); return abortProvider(); };
    await harness.registry.abort(harness.execution.id);
    expect((await settled).status).toBe('aborted');
    expect(order.slice(0, 3)).toEqual(['clarification', 'application', 'provider']);
  });

  it('does not time a run out while it waits for a person, and resumes the clock once answered', async () => {
    const harness = track(await createGenerationHarness({ limits: { timeoutMs: 3_000 }, steps: () => [{ call: { tool: 'request_clarification', args: { questions: [{ question: 'Which total?', rationale: 'It changes the meaning.', impact: 'meaning', proposedDefault: 'sum' }] } } }] }));
    const settled = harness.run();
    await waitFor(() => harness.repos.executions.getById(harness.execution.id)?.status === 'waiting');
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(harness.repos.executions.getById(harness.execution.id)!.status).toBe('waiting');
    expect(harness.provider.sessions[0]!.abortCount).toBe(0);
    const batch = harness.repos.clarifications.listByExecution(harness.execution.id)[0]!;
    harness.clarificationService.answer(batch.id, [{ questionId: batch.questions[0]!.id, value: 'sum' }]);
    const row = await settled;
    expect(row.errorCode).not.toBe('GENERATION_TIMEOUT');
    expect(row.errorCode).toBe('CODE_VERSION_NOT_FINAL');
  }, 10_000);

  it('drains the same way on shutdown without waiting on a person', async () => {
    const harness = track(await createGenerationHarness({ steps: () => [{ call: { tool: 'request_clarification', args: { questions: [{ question: 'Which total?', rationale: 'It changes the meaning.', impact: 'meaning', proposedDefault: 'sum' }] } } }] }));
    const settled = harness.run();
    await waitFor(() => harness.repos.executions.getById(harness.execution.id)?.status === 'waiting');
    const run = harness.runs.get(harness.execution.id)!;
    await harness.registry.drain(2_000);
    expect(run.signal.aborted).toBe(true);
    expect(['aborted', 'failed']).toContain((await settled).status);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
