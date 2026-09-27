import { Value } from '@sinclair/typebox/value';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteTaskResponseSchema, HISTORY_LIVE_REFRESH_MS, HISTORY_PAGE_DEFAULT, RunRecordSchema, statusGroupOf, type ExecutionStatus, RunTimelinePageSchema, TaskHistoryPageSchema, type DeleteTaskResponse, type RunRecord, type RunTimelinePage, type TaskHistoryPage, type TaskResponse } from '@automate/core';
import { getJson, sendJson } from './api-client';

/**
 * Poll while anything visible is running, and not otherwise: parked and finished runs change only when a person acts.
 * @param statuses The statuses currently on screen.
 * @returns The refetch interval, or `false` to stop polling.
 */
export function liveRefreshInterval(statuses: readonly ExecutionStatus[]): number | false {
  return statuses.some((status) => statusGroupOf(status) === 'running') ? HISTORY_LIVE_REFRESH_MS : false;
}

/** Fetch one bounded page of task history. */
export function getTaskHistory(cursor?: string, status = 'all', q = ''): Promise<TaskHistoryPage> {
  const search = new URLSearchParams({ limit: String(HISTORY_PAGE_DEFAULT), status, q });
  if (cursor) search.set('cursor', cursor);
  return getJson(`/tasks?${search}`, (value): value is TaskHistoryPage => Value.Check(TaskHistoryPageSchema, value));
}

/** Keep active history pages fresh; focus and reconnect also refetch. */
export function useTaskHistory(status = 'all', q = '') {
  return useInfiniteQuery({
    queryKey: ['history', status, q], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getTaskHistory(pageParam, status, q),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => liveRefreshInterval(query.state.data?.pages.flatMap((page) => page.items.map((item) => item.latestRun.status)) ?? []),
    refetchOnWindowFocus: true, refetchOnReconnect: true,
  });
}

/** Fetch a page of one task's runs, newest first. */
export function getRunTimeline(taskId: number, cursor?: string): Promise<RunTimelinePage> {
  const search = new URLSearchParams({ limit: String(HISTORY_PAGE_DEFAULT) });
  if (cursor) search.set('cursor', cursor);
  return getJson(`/tasks/${taskId}/runs?${search}`, (value): value is RunTimelinePage => Value.Check(RunTimelinePageSchema, value));
}
/** A task's runs as an infinite query, refreshed while one is running. */
export function useRunTimeline(taskId: number) {
  return useInfiniteQuery({
    queryKey: ['run-timeline', taskId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getRunTimeline(taskId, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => liveRefreshInterval(query.state.data?.pages.flatMap((page) => page.items.map((item) => item.status)) ?? []),
    refetchOnWindowFocus: true, refetchOnReconnect: true,
  });
}

/** Fetch the browser-safe summary of one run's provenance. */
export function useRunRecord(executionId: number) {
  return useQuery({ queryKey: ['run-record', executionId], queryFn: () => getJson(`/executions/${executionId}/record`, (value): value is RunRecord => Value.Check(RunRecordSchema, value)) });
}

/** Every query cached per execution id; a deleted task's runs must leave none behind. */
const RUN_QUERY_KEYS = ['execution', 'execution-events', 'run-record', 'disclosure', 'clarifications', 'verification', 'script-run', 'artifacts'] as const;

/** Whole-task delete, followed by removal of stale task and run cache entries. */
export function useDeleteTask(taskId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<DeleteTaskResponse> => sendJson(`/tasks/${taskId}`, 'DELETE', undefined, (value): value is DeleteTaskResponse => Value.Check(DeleteTaskResponseSchema, value)),
    onSuccess: () => {
      const runIds = client.getQueryData<TaskResponse>(['task', String(taskId)])?.executions.map((run) => run.id) ?? [];
      for (const runId of runIds) for (const key of RUN_QUERY_KEYS) client.removeQueries({ queryKey: [key, runId] });
      client.removeQueries({ queryKey: ['task', String(taskId)] });
      client.removeQueries({ queryKey: ['run-timeline', taskId] });
      client.removeQueries({ queryKey: ['task-uploads', taskId] });
      void client.invalidateQueries({ queryKey: ['history'] });
    },
  });
}
