import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeAgentProvider } from '../agent/testing/fake-agent-provider';
import {
  ensureAppDirectories,
  getAppPaths,
  type AppPaths,
} from '../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../db/repositories/execution-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { createLogger } from '../logging/logger';
import { PassthroughRunStrategy } from './run-strategy';
import { TaskSession } from './task-session';
import { TextCoalescer } from './text-coalescer';

let root: string;
let paths: AppPaths;
let connection: DatabaseConnection;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-session-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
});
afterEach(() => {
  connection.close();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function fixture(
  provider: FakeAgentProvider,
  seed?: (events: ConversationEventRepository, executionId: number) => void,
) {
  const tasks = new TaskRepository(connection);
  const executions = new ExecutionRepository(connection);
  const events = new ConversationEventRepository(connection);
  const task = tasks.create({ name: 'Say hello', description: 'Say hello' });
  const execution = executions.create(task.id);
  seed?.(events, execution.id);
  const session = new TaskSession({
    task,
    execution,
    provider,
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths,
    model: { provider: 'fake', id: 'fake-model' },
    auth: { mode: 'managed' },
    logger: createLogger('silent'),
  });
  return { task, execution, executions, events, session };
}

describe('TaskSession', () => {
  it('persists before broadcasting a gap-free complete transcript', async () => {
    const provider = new FakeAgentProvider([
      {
        events: [
          {
            type: 'assistant_text',
            text: 'Hel',
            at: '2026-09-22T00:00:01.000Z',
          },
          {
            type: 'assistant_text',
            text: 'lo',
            at: '2026-09-22T00:00:01.010Z',
          },
          {
            type: 'turn_finished',
            usage: { turns: 1, outputTokens: 2 },
            at: '2026-09-22T00:00:02.000Z',
          },
        ],
        result: {
          outcome: 'completed',
          stopReason: 'stop',
          usage: { turns: 1, outputTokens: 2 },
        },
      },
    ]);
    const { execution, executions, events, session } = fixture(provider);
    const seen: number[] = [];
    session.subscribe((event) => {
      seen.push(event.seq);
      expect(events.maxSeq(execution.id)).toBe(event.seq);
    });
    await session.start();
    const page = events.listAfter(execution.id, 0, 100);
    expect(page.events.map((event) => event.type)).toEqual([
      'state_changed',
      'user_prompt',
      'assistant_text',
      'turn_finished',
      'state_changed',
    ]);
    expect((page.events[2] as { text: string }).text).toBe('Hello');
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(executions.getById(execution.id)).toMatchObject({
      status: 'completed',
      usageTurns: 1,
      usageInputTokens: null,
      usageOutputTokens: 2,
    });
    expect(provider.sessions[0]?.closeCount).toBe(1);
    expect(provider.opened[0]?.executionId).toBe(String(execution.id));
  });

  it('records sanitized failures and continues an existing sequence', async () => {
    const provider = new FakeAgentProvider([
      {
        events: [
          {
            type: 'failed',
            error: { code: 'SAFE', message: 'Try again.' },
            at: '2026-09-22T00:00:02.000Z',
          },
        ],
        result: { outcome: 'failed', stopReason: 'error', usage: { turns: 0 } },
      },
    ]);
    const f = fixture(provider, (events, executionId) =>
      events.append(executionId, {
        seq: 1,
        type: 'user_prompt',
        text: 'old',
        at: '2026-09-22T00:00:00.000Z',
      }),
    );
    await f.session.start();
    expect(
      f.events
        .listAfter(f.execution.id, 0, 100)
        .events.map((event) => event.seq),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(f.executions.getById(f.execution.id)).toMatchObject({
      status: 'failed',
      errorCode: 'SAFE',
      errorMessage: 'Try again.',
    });
  });

  it('coalesces on time, size, and explicit flush', () => {
    vi.useFakeTimers();
    const output: string[] = [];
    const c = new TextCoalescer((event) => output.push(event.text), 100, 5);
    c.push({ type: 'assistant_text', text: 'a', at: 'now' });
    vi.advanceTimersByTime(100);
    expect(output).toEqual(['a']);
    c.push({ type: 'assistant_text', text: '12345', at: 'now' });
    expect(output).toEqual(['a', '12345']);
    c.push({ type: 'assistant_text', text: 'z', at: 'now' });
    c.dispose();
    expect(output).toEqual(['a', '12345', 'z']);
  });
});
