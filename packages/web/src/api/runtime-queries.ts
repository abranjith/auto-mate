import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { RuntimePrepareResponseSchema, RuntimeStatusResponseSchema, type RuntimeKind, type RuntimePrepareResponse, type RuntimeStatusResponse } from '@automate/core';
import { getJson, sendJson } from './api-client';

const KEY = ['runtime', 'status'] as const;

/** Poll while preparation is in progress and show durable readiness. */
export function useRuntimeStatus() {
  return useQuery({ queryKey: KEY, queryFn: () => getJson('/runtime', (value): value is RuntimeStatusResponse => Value.Check(RuntimeStatusResponseSchema, value)), refetchInterval: (query) => query.state.data?.script.environment?.status === 'preparing' || query.state.data?.verify.environment?.status === 'preparing' ? 2_000 : 30_000 });
}

/** Prepare one locked environment and refresh its status. */
export function usePrepareRuntime() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (kind: RuntimeKind) => sendJson('/runtime/prepare', 'POST', { kind }, (value): value is RuntimePrepareResponse => Value.Check(RuntimePrepareResponseSchema, value)), onSuccess: () => void client.invalidateQueries({ queryKey: KEY }) });
}
