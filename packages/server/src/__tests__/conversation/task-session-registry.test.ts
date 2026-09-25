import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionLimitReachedError } from '@automate/core';
import { FakeAgentProvider } from '../../agent/testing/fake-agent-provider';
import {
  ensureAppDirectories,
  getAppPaths,
  type AppPaths,
} from '../../config/app-paths';
import { openDatabase, type DatabaseConnection } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { ConversationEventRepository } from '../../db/repositories/conversation-event-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { createLogger } from '../../logging/logger';
import { PassthroughRunStrategy } from '../../conversation/run-strategy';
import { TaskSessionRegistry } from '../../conversation/task-session-registry';
import { CodeVersionRepository } from '../../db/repositories/code-version-repository';
import { VerificationRepository } from '../../db/repositories/verification-repository';
import { ApprovalRepository } from '../../db/repositories/approval-repository';
import { ScriptRunRepository } from '../../db/repositories/script-run-repository';

let root: string;
let paths: AppPaths;
let connection: DatabaseConnection;
let tasks: TaskRepository;
let executions: ExecutionRepository;
let events: ConversationEventRepository;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automate-registry-'));
  paths = getAppPaths(root);
  ensureAppDirectories(paths);
  connection = openDatabase(paths);
  migrateDatabase(connection);
  tasks = new TaskRepository(connection);
  executions = new ExecutionRepository(connection);
  events = new ConversationEventRepository(connection);
});
afterEach(() => {
  connection.close();
  rmSync(root, { recursive: true, force: true });
});
function registry(cap: number, onInterrupted?: (id: number) => void) {
  return new TaskSessionRegistry({
    ...(onInterrupted ? { onInterrupted } : {}),
    provider: new FakeAgentProvider(),
    executions,
    events,
    strategy: new PassthroughRunStrategy(),
    paths,
    model: () => ({ provider: 'fake', id: 'fake' }),
    auth: () => ({ mode: 'managed' }),
    logger: createLogger('silent'),
    maxConcurrentExecutions: cap,
  });
}
function row() {
  const task = tasks.create({ name: 'A', description: 'A' });
  return { task, execution: executions.create(task.id) };
}

describe('TaskSessionRegistry', () => {
  it('reads and enforces different configured caps', () => {
    for (const cap of [1, 3]) {
      const r = registry(cap);
      const rows = Array.from({ length: cap + 1 }, row);
      for (const item of rows.slice(0, cap)) r.start(item.execution, item.task);
      expect(() => r.start(rows[cap]!.execution, rows[cap]!.task)).toThrow(
        ExecutionLimitReachedError,
      );
    }
  });

  it('reconciles active rows once with a terminal event', () => {
    const pending = row();
    const generating = row();
    executions.markStarted(generating.execution.id);
    const complete = row();
    executions.markStarted(complete.execution.id);
    executions.markSettled(complete.execution.id, { status: 'completed' });
    const r = registry(1);
    expect(r.reconcileOnStartup()).toBe(2);
    expect(r.reconcileOnStartup()).toBe(0);
    for (const id of [pending.execution.id, generating.execution.id]) {
      expect(executions.getById(id)).toMatchObject({
        status: 'failed',
        errorCode: 'EXECUTION_INTERRUPTED',
      });
      expect(events.listAfter(id, 0, 10).events.at(-1)).toMatchObject({
        type: 'state_changed',
        to: 'failed',
      });
    }
    expect(executions.getById(complete.execution.id)?.status).toBe('completed');
  });
  it('interrupts active rows, leaves the two gates untouched, and settles in-flight child rows', () => {
    const c = connection;
    const versions = new CodeVersionRepository(c);
    const verifications = new VerificationRepository(c);
    const approvals = new ApprovalRepository(c);
    const runs = new ScriptRunRepository(c);
    const at = (status: string) => { const item = row(); c.client.prepare('UPDATE execution SET status = ?, started_at = 1 WHERE id = ?').run(status, item.execution.id); return item.execution.id; };
    const seal = (executionId: number) => { const draft = versions.openDraft(executionId, 1); versions.putFile(draft.id, { path: 'main.py', role: 'script', content: 'x' }); return versions.seal(draft.id); };
    const runtime = { pythonVersion: '3.12.4', uvVersion: 'uv', platform: 'linux', arch: 'x64', packages: [] };
    const ids = Object.fromEntries(['pending', 'generating', 'verifying', 'executing', 'waiting', 'awaiting_approval', 'awaiting_review', 'completed'].map((status) => [status, at(status)])) as Record<string, number>;
    const verifyingVersion = seal(ids.verifying!);
    verifications.open({ executionId: ids.verifying!, codeVersionId: verifyingVersion.id, contentDigest: verifyingVersion.contentDigest!, runtimeFingerprint: 'f'.repeat(64), runtimeDetail: runtime });
    const executingVersion = seal(ids.executing!);
    const pass = verifications.open({ executionId: ids.executing!, codeVersionId: executingVersion.id, contentDigest: executingVersion.contentDigest!, runtimeFingerprint: 'f'.repeat(64), runtimeDetail: runtime });
    verifications.settle(pass.id, { status: 'passed', summary: 's', durationMs: 1, checks: [] });
    c.client.prepare("UPDATE execution SET status = 'awaiting_approval' WHERE id = ?").run(ids.executing!);
    approvals.decide({ executionId: ids.executing!, codeVersionId: executingVersion.id, verificationRunId: pass.id, contentDigest: executingVersion.contentDigest!, runtimeFingerprint: 'f'.repeat(64), intentDigest: 'i', decision: 'approved', acknowledgedWarnings: false }, 'executing');
    runs.openGated({ executionId: ids.executing!, codeVersionId: executingVersion.id, contentDigest: executingVersion.contentDigest!, runtimeFingerprint: 'f'.repeat(64), dirPath: 'runs/x', inputs: [] });
    const parkedBefore = [ids.awaiting_approval!, ids.awaiting_review!].map((id) => executions.getById(id));
    const r = registry(1, (id) => { verifications.abortRunning(id); runs.abortRunning(id); });
    expect(r.reconcileOnStartup()).toBe(5);
    expect(r.reconcileOnStartup()).toBe(0);
    for (const status of ['pending', 'generating', 'verifying', 'executing', 'waiting']) {
      const id = ids[status]!;
      expect(executions.getById(id)).toMatchObject({ status: 'failed', errorCode: 'EXECUTION_INTERRUPTED' });
      const transcript = events.listAfter(id, 0, 10).events;
      expect(transcript).toHaveLength(1);
      expect(transcript[0]).toMatchObject({ seq: 1, type: 'state_changed', from: status, to: 'failed' });
    }
    expect(executions.getById(ids.verifying!)?.errorMessage).toBe('This run was interrupted while its code was being checked. Start it again to retry.');
    expect(executions.getById(ids.executing!)?.errorMessage).toMatch(/while the script was running/);
    const aborted = verifications.getLatest(ids.verifying!)!;
    expect(aborted.status).toBe('aborted');
    expect(aborted.settledAt).toBeInstanceOf(Date);
    expect(runs.getByExecution(ids.executing!)).toMatchObject({ status: 'aborted' });
    expect(runs.getByExecution(ids.executing!)?.settledAt).toBeInstanceOf(Date);
    expect([ids.awaiting_approval!, ids.awaiting_review!].map((id) => executions.getById(id))).toEqual(parkedBefore);
    for (const id of [ids.awaiting_approval!, ids.awaiting_review!, ids.completed!]) expect(events.listAfter(id, 0, 10).events).toEqual([]);
  });

  it('frees the slot for a parked execution and not for a generating one — the pair proves the rule', () => {
    for (const [status, allowed] of [['awaiting_approval', true], ['awaiting_review', true], ['waiting', true], ['generating', false]] as const) {
      const r = registry(1);
      const first = row();
      r.start(first.execution, first.task);
      connection.client.prepare('UPDATE execution SET status = ? WHERE id = ?').run(status, first.execution.id);
      const second = row();
      if (allowed) expect(() => r.start(second.execution, second.task)).not.toThrow();
      else expect(() => r.start(second.execution, second.task)).toThrow(ExecutionLimitReachedError);
    }
  });

  it('counts a running phase job against the cap until it settles', async () => {
    const r = registry(1);
    const first = row();
    executions.markStarted(first.execution.id);
    executions.transitionStatus(first.execution.id, 'verifying');
    let release!: () => void;
    r.track(first.execution.id, { abort: () => release(), settled: new Promise<void>((resolve) => { release = resolve; }) });
    expect(r.activeCount()).toBe(1);
    expect(() => r.assertCapacity()).toThrow(ExecutionLimitReachedError);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.activeCount()).toBe(0);
  });

  it('publishes to registry subscribers after the provider session is gone', () => {
    const r = registry(1);
    const item = row();
    const seen: number[] = [];
    const unsubscribe = r.subscribe(item.execution.id, (event) => seen.push(event.seq));
    r.publish(item.execution.id, { type: 'user_prompt', text: 'x', at: 'now' });
    r.publish(item.execution.id, { type: 'user_prompt', text: 'y', at: 'now' });
    unsubscribe();
    r.publish(item.execution.id, { type: 'user_prompt', text: 'z', at: 'now' });
    expect(seen).toEqual([1, 2]);
    expect(events.listAfter(item.execution.id, 0, 10).events.map(({ seq }) => seq)).toEqual([1, 2, 3]);
  });
});
