import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HISTORY_STATUS_GROUPS, type ExecutionStatus } from '@automate/core';
import { createTempStore, type TempStore } from '../../support/ingestion-fixtures';
import { TaskRepository } from '../../../db/repositories/task-repository';
import { ExecutionRepository } from '../../../db/repositories/execution-repository';
import { HistoryRepository } from '../../../db/repositories/history-repository';

const stores: TempStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
function fixture() {
  const store = createTempStore('automate-history-'); stores.push(store);
  return { store, tasks: new TaskRepository(store.connection), executions: new ExecutionRepository(store.connection), history: new HistoryRepository(store.connection) };
}
type Fixture = ReturnType<typeof fixture>;
const setStatus = (f: Fixture, id: number, status: ExecutionStatus) => f.store.connection.client.prepare('update execution set status = ? where id = ?').run(status, id);

/** Capture every statement a call prepares, with the arguments it was executed with. */
function captureStatements(f: Fixture, action: () => unknown): { sql: string; args: unknown[] }[] {
  const client = f.store.connection.client;
  const original = client.prepare.bind(client);
  const seen: { sql: string; args: unknown[] }[] = [];
  const spy = vi.spyOn(client, 'prepare').mockImplementation((sql: string) => {
    const statement = original(sql);
    const entry = { sql, args: [] as unknown[] }; seen.push(entry);
    for (const method of ['all', 'get', 'run', 'iterate'] as const) {
      const bound = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { entry.args = args; return bound(...args); };
    }
    return statement;
  });
  try { action(); } finally { spy.mockRestore(); }
  return seen;
}
function plan(f: Fixture, statement: { sql: string; args: unknown[] }): string {
  return (f.store.connection.client.prepare(`explain query plan ${statement.sql}`).all(...(statement.args as never[])) as { detail: string }[]).map(({ detail }) => detail).join(' | ');
}

describe('HistoryRepository', () => {
  it('uses five SQL queries for a page regardless of page size', () => {
    const f = fixture();
    for (let index = 0; index < 60; index++) f.tasks.createWithExecution(`Task ${index}`);
    for (const limit of [1, 20, 50]) expect(captureStatements(f, () => f.history.listTasks({ limit })), `limit ${limit}`).toHaveLength(5);
  });

  it('pages tasks by the latest execution without duplicates, omissions, or ties', () => {
    const f = fixture();
    for (let i = 1; i <= 45; i++) {
      const created = f.tasks.createWithExecution(`Task ${i}`);
      for (let extra = 0; extra < i % 4; extra++) f.store.connection.client.prepare("insert into execution (task_id, status, trigger) values (?, 'failed', 'rerun')").run(created.task.id);
    }
    const pages: number[] = []; const all = []; let cursor: number | undefined; let hasMore = true;
    while (hasMore) {
      const page = f.history.listTasks({ limit: 20, ...(cursor ? { cursor } : {}) });
      pages.push(page.items.length); all.push(...page.items); cursor = page.nextCursor ? Number(page.nextCursor) : undefined;
      hasMore = page.hasMore;
    }
    expect(pages).toEqual([20, 20, 5]);
    expect(new Set(all.map((item) => item.task.id)).size).toBe(45);
    const latest = f.store.connection.client.prepare('select task_id taskId, max(id) id from execution group by task_id').all() as { taskId: number; id: number }[];
    for (const item of all) expect(item.latestRun.id).toBe(latest.find(({ taskId }) => taskId === item.task.id)?.id);
    expect(all.map((item) => item.latestRun.id)).toEqual([...all.map((item) => item.latestRun.id)].sort((a, b) => b - a));
  });

  it('lists a task given a new run between pages at most once, and at the top of a fresh first page', () => {
    const f = fixture();
    const created = Array.from({ length: 30 }, (_, index) => f.tasks.createWithExecution(`Task ${index}`));
    const first = f.history.listTasks({ limit: 20 });
    const moved = created[2]!; // on page 2 (oldest tasks come last)
    f.executions.markSettled(moved.execution.id, { status: 'failed' });
    const retry = f.executions.createRetry(moved.execution.id, null);
    const second = f.history.listTasks({ limit: 20, cursor: Number(first.nextCursor) });
    const ids = [...first.items, ...second.items].map((item) => item.task.id);
    expect(ids.filter((id) => id === moved.task.id).length).toBeLessThanOrEqual(1);
    expect(f.history.listTasks({ limit: 20 }).items[0]).toMatchObject({ task: { id: moved.task.id }, latestRun: { id: retry.id }, runCount: 2 });
  });

  it('filters by every status group, including waiting under needs_you', () => {
    const f = fixture();
    const byStatus = new Map<ExecutionStatus, number>();
    for (const status of Object.values(HISTORY_STATUS_GROUPS).flat()) {
      const created = f.tasks.createWithExecution(`In ${status}`);
      setStatus(f, created.execution.id, status); byStatus.set(status, created.task.id);
    }
    for (const [group, statuses] of Object.entries(HISTORY_STATUS_GROUPS)) {
      const listed = f.history.listTasks({ limit: 50, group: group as keyof typeof HISTORY_STATUS_GROUPS }).items.map((item) => item.task.id).sort();
      expect(listed, group).toEqual(statuses.map((status) => byStatus.get(status)!).sort());
    }
    expect(f.history.listTasks({ limit: 50, group: 'needs_you' }).items.map((item) => item.latestRun.status)).toContain('waiting');
    expect(f.history.listTasks({ limit: 50, group: 'all' }).items).toHaveLength(byStatus.size);
  });

  it('searches names and prompts as literal text', () => {
    const f = fixture();
    const percent = f.tasks.createWithExecution('Margin 50% by month');
    f.tasks.createWithExecution('Margin 500 by month');
    const underscore = f.tasks.createWithExecution('Rename a_c columns');
    f.tasks.createWithExecution('Rename abc columns');
    const described = f.tasks.create({ name: 'Quarterly', description: 'Total the invoices by supplier' });
    f.executions.create(described.id);
    const search = (q: string) => f.history.listTasks({ limit: 50, q }).items.map((item) => item.task.id);
    expect(search('50%')).toEqual([percent.task.id]);
    expect(search('a_c')).toEqual([underscore.task.id]);
    expect(search('5_0')).toEqual([]);
    expect(search('INVOICES')).toEqual([described.id]);
    expect(search('')).toHaveLength(5);
  });

  it('pages a task timeline newest first and reports guidance and feedback flags without their text', () => {
    const f = fixture();
    const created = f.tasks.createWithExecution('Timeline');
    let previous = created.execution.id;
    for (let index = 0; index < 24; index++) {
      setStatus(f, previous, index % 2 ? 'rejected' : 'failed');
      previous = (index % 2 ? f.executions.createFeedbackRetry(previous, `private feedback ${index}`) : f.executions.createRetry(previous, index % 4 === 0 ? `private guidance ${index}` : null)).id;
    }
    const first = f.history.listRuns(created.task.id, { limit: 20 });
    const second = f.history.listRuns(created.task.id, { limit: 20, cursor: Number(first.nextCursor) });
    expect([first.items.length, second.items.length, second.hasMore]).toEqual([20, 5, false]);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(first.items.find((item) => item.trigger === 'feedback')).toMatchObject({ hasReviewFeedback: false, hasGuidance: true });
    expect(JSON.stringify([first, second])).not.toMatch(/private (guidance|feedback)/);
  });

  it('returns a sparse record for a FEAT-103-era text-only run', () => {
    const f = fixture();
    const created = f.tasks.createWithExecution('Text only');
    const record = f.history.getRunRecord(created.execution.id);
    expect(record).toMatchObject({ inputs: [], inputsReadByRun: null, disclosure: null, questions: null, code: null, checks: null, approval: null, scriptRun: null, outputs: null, chain: { previous: null, next: [] }, transcript: { lastSeq: 0 } });
    expect(f.history.taskCounts(created.task.id)).toEqual({ runs: 1, inputs: 0, outputs: 0, openRunId: created.execution.id, savedAs: [] });
    expect(f.history.getRunRecord(999)).toBeUndefined();
  });

  it('links a guidance retry and a feedback re-run in both directions', () => {
    const f = fixture();
    const created = f.tasks.createWithExecution('Chain');
    f.executions.markSettled(created.execution.id, { status: 'failed' });
    const retry = f.executions.createRetry(created.execution.id, 'Use the net amount');
    setStatus(f, retry.id, 'rejected');
    const feedback = f.executions.createFeedbackRetry(retry.id, 'Totals are wrong');
    expect(f.history.getRunRecord(created.execution.id)?.chain).toEqual({ previous: null, next: [retry.id] });
    expect(f.history.getRunRecord(retry.id)).toMatchObject({ chain: { previous: created.execution.id, next: [feedback.id] }, personWords: { guidance: 'Use the net amount' } });
    expect(f.history.getRunRecord(feedback.id)?.chain).toEqual({ previous: retry.id, next: [] });
  });

  it('selects none of the columns history must never read', () => {
    const source = readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'db', 'repositories', 'history-repository.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The FEAT-110 spec §2 "never selected by history" column: a read model widens one field at a time.
    for (const column of ['agent_log_path', 'agent_session_id', 'payload', 'payload_snapshot', 'prompt_text', 'answer', 'rationale', 'content', 'stdout', 'stderr', 'message']) {
      expect(source, column).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it('serves each list from its index, as EXPLAIN QUERY PLAN reports', () => {
    const f = fixture();
    for (let index = 0; index < 20; index++) f.tasks.createWithExecution(`Task ${index}`);
    const [needsYou] = captureStatements(f, () => f.history.listTasks({ limit: 20, group: 'needs_you' }));
    expect(plan(f, needsYou!)).toMatch(/SEARCH e USING INDEX execution_parked/);
    expect(plan(f, needsYou!)).toMatch(/SEARCH later USING COVERING INDEX execution_task_id/);
    const [timeline] = captureStatements(f, () => f.history.listRuns(1, { limit: 20 }));
    expect(plan(f, timeline!)).toMatch(/SEARCH e USING (COVERING )?INDEX execution_task_id/);
    const [active] = captureStatements(f, () => f.executions.listActive());
    expect(plan(f, active!)).toMatch(/USING INDEX execution_active/);
    const [parked] = captureStatements(f, () => f.executions.listParked());
    expect(plan(f, parked!)).toMatch(/USING INDEX execution_parked/);
  });
});
