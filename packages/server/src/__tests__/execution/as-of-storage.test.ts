import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAppDirectories, getAppPaths } from '../../config/app-paths';
import { openDatabase } from '../../db/client';
import { migrateDatabase } from '../../db/migrate';
import { TaskRepository } from '../../db/repositories/task-repository';
import { ExecutionRepository } from '../../db/repositories/execution-repository';
import { executionAsOfEnvironment } from '../../execution/as-of-storage';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('as-of storage', () => {
  it('sets every column on first runs, guidance retries, and feedback retries', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'automate-as-of-')); roots.push(root);
    const paths = getAppPaths(root); ensureAppDirectories(paths);
    const connection = openDatabase(paths);
    try {
      migrateDatabase(connection);
      const tasks = new TaskRepository(connection);
      const executions = new ExecutionRepository(connection);
      const first = tasks.createWithExecution('Summarize', undefined, 'Europe/London').execution;
      executions.markSettled(first.id, { status: 'failed' });
      const retry = executions.createRetry(first.id, 'Try again');
      executions.markSettled(retry.id, { status: 'failed' });
      const feedback = executions.createFeedbackRetry(first.id, 'Different result');
      for (const row of [first, retry, feedback]) {
        expect([row.asOfAt, row.asOfDate, row.asOfTimezone, row.asOfSource].every((value) => value !== null)).toBe(true);
        expect(Object.keys(executionAsOfEnvironment(row)).sort()).toEqual(['AUTOMATE_AS_OF', 'AUTOMATE_AS_OF_DATE', 'AUTOMATE_TIMEZONE']);
      }
      expect(retry.asOfAt).toEqual(first.asOfAt);
      expect(feedback.asOfDate).toBe(first.asOfDate);
      expect(retry.asOfSource).toBe('copied');
      expect(() => tasks.createWithExecution('bad', undefined, 'Mars/Olympus')).toThrow('Unsupported time zone');
      const nullRow = { ...first, asOfAt: null, asOfDate: null, asOfTimezone: null, asOfSource: null };
      expect(executionAsOfEnvironment(nullRow)).toEqual({});
    } finally { connection.close(); }
  });
});
