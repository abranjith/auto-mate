import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { AutoMateError, type AgentToolDefinition, type ConversationEvent, type UnnumberedConversationEvent } from '@automate/core';
import { FakeAgentProvider, type FakeAgentStep } from '../../agent/testing/fake-agent-provider';
import { ensureAppDirectories, getAppPaths, type AppPaths } from '../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { ConversationEventRepository } from '../../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { createLogger } from '../../logging/logger';
import type { BuiltRun, RunLifecycle, RunStrategy } from '../../conversation/run-strategy';
import { TaskSession } from '../../conversation/task-session';
import { elideToolInput } from '../../conversation/tool-elision';

let root: string;
let paths: AppPaths;
let connection: DatabaseConnection;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-session-gen-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
});
afterEach(() => {
  connection.close();
  rmSync(root, { recursive: true, force: true });
});

const SCRIPT = 'import pandas as pd\nprint("secret-script-body")\n';
const at = '2026-09-24T00:00:00.000Z';
const completed = { outcome: 'completed' as const, stopReason: 'stop', usage: { turns: 1 } };

/** A strategy exposing two tools: one that elides `content`, one that publishes a generation event through the session. */
function harness(steps: readonly FakeAgentStep[], lifecycle?: RunLifecycle, guidance: string | null = null) {
  const received: unknown[] = [];
  const write: AgentToolDefinition = { name: 'fake_write', description: 'write', parameters: Type.Object({ path: Type.String(), content: Type.String() }), redactArgsInEvents: ['content', 'absent'], execute: async (args) => { received.push(args); return { path: (args as { path: string }).path, byteSize: 42 }; } };
  const plain: AgentToolDefinition = { name: 'fake_plain', description: 'plain', parameters: Type.Object({ question: Type.String() }), execute: async () => ({ ok: true }) };
  const publish: AgentToolDefinition = { name: 'fake_publish', description: 'publish', parameters: Type.Object({}), execute: async () => { const events: UnnumberedConversationEvent[] = [{ type: 'code_version_sealed', codeVersionId: 1, attempt: 1, digest: 'a'.repeat(64), files: [{ path: 'main.py', role: 'script', byteSize: 42, lineCount: 2 }], at }, { type: 'test_run_finished', attemptId: 1, attempt: 1, outcome: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, droppedLineCount: 4, attemptsRemaining: 2, attemptLimit: 3, manifestPresent: false, at }]; for (const event of events) session.appendApplicationEvent(event); return {}; } };
  const strategy: RunStrategy = { buildRun: async (): Promise<BuiltRun> => ({ prompt: 'go', customTools: [write, plain, publish], ...(lifecycle ? { lifecycle } : {}) }) };
  const provider = new FakeAgentProvider([{ events: [], steps, result: completed }]);
  const tasks = new TaskRepository(connection);
  const executions = new ExecutionRepository(connection);
  const events = new ConversationEventRepository(connection);
  const created = tasks.createWithExecution('Summarize sales');
  const execution = guidance === null ? created.execution : executions.createRetry(created.execution.id, guidance);
  const session = new TaskSession({ task: created.task, execution, provider, executions, events, strategy, paths, model: { provider: 'fake', id: 'fake' }, auth: { mode: 'managed' }, logger: createLogger('silent') });
  const transcript = () => events.listAfter(execution.id, 0, 500).events;
  return { session, provider, received, transcript, executions, executionId: execution.id };
}

describe('tool-argument elision', () => {
  it('replaces a named argument with its size, leaves others, and ignores absent keys', () => {
    expect(elideToolInput({ path: 'main.py', content: 'héllo' }, ['content', 'absent'])).toEqual({ path: 'main.py', content: { elided: true, byteSize: 6 } });
    expect(elideToolInput({ path: 'main.py' }, ['content'])).toEqual({ path: 'main.py' });
    expect(elideToolInput('text', ['content'])).toBe('text');
    expect(elideToolInput(null, ['content'])).toBeNull();
    expect(elideToolInput({ content: { nested: true } }, ['content'])).toEqual({ content: { elided: true, byteSize: 15 } });
  });

  it('persists the tool start with the content elided while execute() receives it in full', async () => {
    const { session, received, transcript } = harness([{ call: { tool: 'fake_write', args: { path: 'main.py', content: SCRIPT } } }]);
    await session.start();
    expect(received).toEqual([{ path: 'main.py', content: SCRIPT }]);
    const started = transcript().find((event) => event.type === 'tool_started');
    expect(started).toMatchObject({ tool: 'fake_write', input: { path: 'main.py', content: { elided: true, byteSize: Buffer.byteLength(SCRIPT) } } });
    for (const event of transcript()) expect(JSON.stringify(event)).not.toContain('secret-script-body');
    const rows = connection.client.prepare('SELECT payload FROM conversation_event').all() as { payload: string }[];
    expect(rows.some(({ payload }) => payload.includes('secret-script-body'))).toBe(false);
  });

  it('broadcasts the elided form too, because it elides before persisting', async () => {
    const { session } = harness([{ call: { tool: 'fake_write', args: { path: 'main.py', content: SCRIPT } } }]);
    const seen: ConversationEvent[] = [];
    session.subscribe((event) => seen.push(event));
    await session.start();
    expect(JSON.stringify(seen)).not.toContain('secret-script-body');
    expect(seen.some((event) => event.type === 'tool_started')).toBe(true);
  });

  it('leaves a tool with no redaction list untouched', async () => {
    const { session, transcript } = harness([{ call: { tool: 'fake_plain', args: { question: 'Which region?' } } }]);
    await session.start();
    expect(transcript().find((event) => event.type === 'tool_started')).toMatchObject({ input: { question: 'Which region?' } });
  });
});

describe('generation transcript events', () => {
  it('persists and replays the new kinds with gap-free seq, flushing pending assistant text first', async () => {
    const { session, transcript } = harness([
      { event: { type: 'assistant_text', text: 'Writing the ', at } },
      { event: { type: 'assistant_text', text: 'script now.', at } },
      { call: { tool: 'fake_publish', args: {} } },
      { event: { type: 'assistant_text', text: 'Done.', at } },
    ]);
    await session.start();
    const events = transcript();
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    const kinds = events.map(({ type }) => type);
    expect(kinds).toEqual(['state_changed', 'user_prompt', 'assistant_text', 'tool_started', 'code_version_sealed', 'test_run_finished', 'tool_finished', 'assistant_text', 'state_changed']);
    expect(events[2]).toMatchObject({ type: 'assistant_text', text: 'Writing the script now.' });
  });

  it('records a retry\'s guidance as its own user prompt, after the task description', async () => {
    const { session, transcript } = harness([], undefined, 'Group by month, not by day.');
    await session.start();
    const prompts = transcript().filter((event) => event.type === 'user_prompt').map((event) => (event as { text: string }).text);
    expect(prompts).toEqual(['Summarize sales', 'Group by month, not by day.']);
  });

  it('rejects an unknown kind at the database', () => {
    const { executionId } = harness([]);
    expect(() => connection.client.prepare("INSERT INTO conversation_event (execution_id, seq, kind, payload, at) VALUES (?, 99, 'code_written', '{}', 'x')").run(executionId)).toThrow(/CHECK/);
  });
});

describe('run lifecycle', () => {
  function lifecycle(overrides: Partial<RunLifecycle> = {}) {
    const calls: string[] = [];
    const value: RunLifecycle = {
      cancel: () => calls.push('cancel'),
      settle: (ending) => { calls.push(`settle:${ending.outcome}:${ending.stopError?.code ?? '-'}`); return ending.stopError ? { status: 'failed', error: { code: ending.stopError.code, message: ending.stopError.message }, events: [{ type: 'generation_settled', outcome: 'timed_out', codeVersionId: null, digest: null, attemptsUsed: 0, attemptLimit: 3, summary: 'Stopped at the time limit after 0 attempts.', at }] } : { status: 'completed', events: [{ type: 'generation_settled', outcome: 'finalized', codeVersionId: 1, digest: 'a'.repeat(64), attemptsUsed: 1, attemptLimit: 3, summary: 'Chose attempt 1 of 3.', at }] }; },
      ...overrides,
    };
    return { value, calls };
  }

  it('lets the lifecycle settle the run and records its events before the final state change', async () => {
    const { value, calls } = lifecycle();
    const { session, transcript } = harness([], value);
    const row = await session.start();
    expect(row.status).toBe('completed');
    expect(calls).toEqual(['settle:completed:-']);
    expect(transcript().slice(-2).map(({ type }) => type)).toEqual(['generation_settled', 'state_changed']);
  });

  it('stops between turns when the lifecycle says so, cancelling application work before the provider', async () => {
    const { value, calls } = lifecycle({ onTurnFinished: () => new AutoMateError('GENERATION_COST_LIMIT', 'Cost limit reached.') });
    const { session, transcript, provider } = harness([{ event: { type: 'turn_finished', usage: { turns: 1, costUsd: 1 }, at } }, { until: new Promise(() => undefined) }], value);
    const row = await session.start();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'GENERATION_COST_LIMIT', errorMessage: 'Cost limit reached.' });
    expect(calls).toEqual(['cancel', 'settle:aborted:GENERATION_COST_LIMIT']);
    expect(provider.sessions[0]!.abortCount).toBe(1);
    expect(transcript().slice(-3).map(({ type }) => type)).toEqual(['generation_settled', 'failed', 'state_changed']);
  });

  it('stops mid-turn when the wall clock expires', async () => {
    const { value } = lifecycle({ timeRemainingMs: () => 20, timeoutError: () => new AutoMateError('GENERATION_TIMEOUT', 'Out of time.') });
    const { session } = harness([{ until: new Promise(() => undefined) }], value);
    const row = await session.start();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'GENERATION_TIMEOUT' });
  });

  it('cancels application work before the provider on a person\'s abort', async () => {
    const order: string[] = [];
    const { value } = lifecycle({ cancel: () => order.push('application'), settle: () => ({ status: 'aborted', events: [] }) });
    const { session, provider } = harness([{ until: new Promise(() => undefined) }], value);
    const running = session.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abort = provider.sessions[0]!.abort.bind(provider.sessions[0]!);
    provider.sessions[0]!.abort = () => { order.push('provider'); return abort(); };
    await session.abort();
    expect((await running).status).toBe('aborted');
    expect(order).toEqual(['application', 'provider']);
  });
});
