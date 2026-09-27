import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EXECUTION_STATUSES, HISTORY_LIVE_REFRESH_MS, type ExecutionStatus, type TaskHistoryPage } from '@automate/core';
import { liveRefreshInterval, useDeleteTask, useTaskHistory } from '../../api/history-queries';

const mock = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock('../../api/api-client', () => ({ getJson: mock.getJson, sendJson: mock.sendJson }));

const at = '2026-09-26T10:00:00.000Z';
const page = (...statuses: ExecutionStatus[]): TaskHistoryPage => ({
  items: statuses.map((status, index) => ({ task: { id: index + 1, name: `Task ${index + 1}`, createdAt: at }, latestRun: { id: index + 1, status, trigger: 'manual', createdAt: at, completedAt: null, durationMs: null, errorCode: null, statusSince: null, reuse: null }, runCount: 1, inputCount: 0, latestOutputCount: 0 })),
  nextCursor: null, hasMore: false,
});
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); mock.getJson.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('history live refresh', () => {
  it('polls only while something visible is running', () => {
    const running = new Set(['pending', 'generating', 'verifying', 'executing']);
    for (const status of EXECUTION_STATUSES) expect(liveRefreshInterval([status]), status).toBe(running.has(status) ? HISTORY_LIVE_REFRESH_MS : false);
    expect(liveRefreshInterval([])).toBe(false);
  });

  it('refetches every five seconds while a run is generating, and stops once all are terminal or parked', async () => {
    mock.getJson.mockResolvedValue(page('generating', 'completed'));
    const { result } = renderHook(() => useTaskHistory('all', ''), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mock.getJson).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_LIVE_REFRESH_MS); });
    expect(mock.getJson).toHaveBeenCalledTimes(2);
    mock.getJson.mockResolvedValue(page('awaiting_approval', 'completed'));
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_LIVE_REFRESH_MS); });
    expect(mock.getJson).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(HISTORY_LIVE_REFRESH_MS * 4); });
    expect(mock.getJson).toHaveBeenCalledTimes(3);
  });
});

describe('useDeleteTask', () => {
  it('drops every cached query for the task and its runs, and refreshes the history list', async () => {
    vi.useRealTimers();
    const client = new QueryClient();
    client.setQueryData(['task', '3'], { task: { id: 3 }, executions: [{ id: 9 }, { id: 10 }], counts: { runs: 2, inputs: 0, outputs: 0, openRunId: null } });
    for (const key of ['execution', 'execution-events', 'run-record', 'disclosure', 'clarifications', 'verification', 'script-run', 'artifacts']) for (const id of [9, 10]) client.setQueryData([key, id], { id });
    client.setQueryData(['run-timeline', 3], { pages: [] });
    client.setQueryData(['task-uploads', 3], { uploads: [] });
    client.setQueryData(['execution', 99], { id: 99 });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mock.sendJson.mockResolvedValue({ taskId: 3, removed: { runs: 2, inputs: 0, outputs: 0 }, filesPendingRemoval: 0 });
    const { result } = renderHook(() => useDeleteTask(3), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await act(async () => { await result.current.mutateAsync(); });
    expect(mock.sendJson).toHaveBeenCalledWith('/tasks/3', 'DELETE', undefined, expect.any(Function));
    for (const key of ['execution', 'execution-events', 'run-record', 'disclosure', 'clarifications', 'verification', 'script-run', 'artifacts']) for (const id of [9, 10]) expect(client.getQueryData([key, id]), `${key} ${id}`).toBeUndefined();
    expect(client.getQueryData(['task', '3'])).toBeUndefined();
    expect(client.getQueryData(['run-timeline', 3])).toBeUndefined();
    expect(client.getQueryData(['task-uploads', 3])).toBeUndefined();
    expect(client.getQueryData(['execution', 99])).toEqual({ id: 99 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history'] });
  });
});
