import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TaskHistoryQuerySchema, TaskHistoryItemSchema, TaskHistoryPageSchema, RunTimelineQuerySchema, RunTimelineItemSchema, RunTimelinePageSchema, RunRecordSchema, TaskCountsSchema, DeleteTaskResponseSchema } from '../../contracts/history-api';
import { ExecutionSummarySchema, TaskResponseSchema } from '../../contracts/task-api';

describe('history API contracts', () => {
  it('bounds list queries and rejects unknown keys', () => {
    expect(Value.Check(TaskHistoryQuerySchema, { limit: '50', cursor: '21', status: 'needs_you', q: 'sales' })).toBe(true);
    for (const limit of ['51', '0', '-1', 'abc']) expect(Value.Check(TaskHistoryQuerySchema, { limit })).toBe(false);
    expect(Value.Check(TaskHistoryQuerySchema, { q: 'x'.repeat(201) })).toBe(false);
    expect(Value.Check(TaskHistoryQuerySchema, { status: 'unknown' })).toBe(false);
    expect(Value.Check(TaskHistoryQuerySchema, { extra: 'x' })).toBe(false);
  });

  it('allows only summary fields in the run record tree', () => {
    const visit = (schema: unknown): void => {
      if (!schema || typeof schema !== 'object') return;
      for (const [key, value] of Object.entries(schema)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const name of Object.keys(value)) expect(name).not.toMatch(/path|snapshot|stdout|stderr|content|payload|logPath/i);
        }
        visit(value);
      }
    };
    visit(RunRecordSchema);
  });

  it('round-trips every history schema through JSON unchanged', () => {
    const at = '2026-09-26T10:00:00.000Z';
    const item = { task: { id: 1, name: 'Monthly', createdAt: at }, latestRun: { id: 3, status: 'awaiting_approval', trigger: 'rerun', createdAt: at, completedAt: null, durationMs: null, errorCode: null, statusSince: at, reuse: null }, runCount: 2, inputCount: 1, latestOutputCount: 0 };
    const run = { id: 3, taskId: 1, runNumber: 2, status: 'failed', trigger: 'feedback', retryOfExecutionId: 2, hasGuidance: true, hasReviewFeedback: false, createdAt: at, completedAt: at, durationMs: 5, errorCode: 'EXECUTION_INTERRUPTED', outputCount: 1, reuse: null };
    const counts = { runs: 2, inputs: 1, outputs: 3, openRunId: null };
    const record = {
      execution: { id: 3, taskId: 1, runNumber: 2, status: 'completed', trigger: 'manual', retryOfExecutionId: null, provider: 'fake', model: 'm', createdAt: at, startedAt: at, completedAt: at, durationMs: 5, errorCode: null, errorMessage: null },
      personWords: { guidance: null, reviewFeedback: 'Off by one' }, chain: { previous: null, next: [{ id: 4, runNumber: 3 }] },
      inputs: [{ id: 1, originalFilename: 'a.csv', format: 'csv', byteSize: 10, sha256: 'a'.repeat(64) }], inputsReadByRun: true,
      disclosure: { provider: 'fake', model: 'm', sendCount: 1, grantedAt: at }, questions: { total: 1, answered: 1, byPerson: 1, seeded: 0, defaulted: 0, declined: 0 },
      code: { id: 7, attempt: 1, digest: 'd'.repeat(64), shortDigest: 'd'.repeat(12), testsPassed: true, attemptCount: 1 },
      checks: { status: 'passed', blockingCount: 0, advisoryCount: 0, summary: 'ok', runtime: 'Python 3.12.4 on linux · 8 packages' }, approval: { decidedAt: at, acknowledgedWarnings: false },
      scriptRun: { status: 'succeeded', exitCode: 0, durationMs: 5, limitBreach: null, outputTruncated: false, declaredOutputCount: 1, producedOutputCount: 1, artifactCount: 1, unregisteredOutputCount: 0 },
      outputs: { count: 1 }, transcript: { lastSeq: 9 }, reuse: null, asOf: { at: 1790416800, date: '2026-09-26', timeZone: 'UTC', source: 'now' },
    };
    const summary = { id: 3, taskId: 1, status: 'completed', trigger: 'manual', retryOfExecutionId: null, provider: null, model: null, usage: {}, startedAt: null, completedAt: null, durationMs: null, error: null, createdAt: at };
    const values = [
      [TaskHistoryQuerySchema, { cursor: '9', limit: '20', status: 'done', q: 'sales' }],
      [TaskHistoryItemSchema, item], [TaskHistoryPageSchema, { items: [item], nextCursor: '3', hasMore: true }],
      [RunTimelineQuerySchema, { cursor: '4', limit: '50' }], [RunTimelineItemSchema, run], [RunTimelinePageSchema, { items: [run], nextCursor: null, hasMore: false }],
      [RunRecordSchema, record], [RunRecordSchema, { ...record, inputs: [], inputsReadByRun: null, disclosure: null, questions: null, code: null, checks: null, approval: null, scriptRun: null, outputs: null }],
      [TaskCountsSchema, counts], [DeleteTaskResponseSchema, { taskId: 1, removed: { runs: 2, inputs: 1, outputs: 3 }, filesPendingRemoval: 0 }],
      [ExecutionSummarySchema, summary], [TaskResponseSchema, { task: { id: 1, name: 'Monthly', description: 'x', createdAt: at, updatedAt: at }, executions: [summary], counts }],
    ] as const;
    for (const [schema, value] of values) {
      const copy: unknown = JSON.parse(JSON.stringify(value));
      expect(copy).toEqual(value);
      expect(Value.Check(schema, copy), JSON.stringify(value).slice(0, 60)).toBe(true);
    }
  });
});
