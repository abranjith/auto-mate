import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import {
  AgentConfigResponseSchema, AutoMateError, ConnectionTestResponseSchema, ERROR_CODES, ProviderCatalogResponseSchema,
  type AgentConfig, type AgentConfigUpdate, type ConnectionTestResponse, type ProviderCatalogResponse,
} from '@automate/core';
import { getJson, sendJson } from './api-client';

const AGENT_CONFIG_KEY = ['agent', 'config'] as const;
const PROVIDER_CATALOG_KEY = ['agent', 'providers'] as const;

/** Read the saved provider and model selection. @returns A cached query over `GET /api/agent/config`. @example const { data } = useAgentConfig() */
export function useAgentConfig(): UseQueryResult<AgentConfig, AutoMateError> {
  return useQuery<AgentConfig, AutoMateError>({
    queryKey: AGENT_CONFIG_KEY,
    queryFn: () => getJson('/agent/config', (value): value is AgentConfig => Value.Check(AgentConfigResponseSchema, value)),
    staleTime: 30_000,
    retry: 1,
  });
}

/** Read the provider credential status and model catalog. @returns A cached query over `GET /api/agent/providers`. @example const { data } = useProviderCatalog() */
export function useProviderCatalog(): UseQueryResult<ProviderCatalogResponse, AutoMateError> {
  return useQuery<ProviderCatalogResponse, AutoMateError>({
    queryKey: PROVIDER_CATALOG_KEY,
    // The catalog only changes when a credential is added outside the app, so
    // it is cached for a minute rather than refetched on every focus.
    queryFn: () => getJson('/agent/providers', (value): value is ProviderCatalogResponse => Value.Check(ProviderCatalogResponseSchema, value)),
    staleTime: 60_000,
    retry: 1,
  });
}

/** Save a provider and model selection. @returns A mutation that invalidates the config and catalog on success. @example useUpdateAgentConfig().mutate(edited) */
export function useUpdateAgentConfig(): UseMutationResult<AgentConfig, AutoMateError, AgentConfigUpdate> {
  const queryClient = useQueryClient();
  return useMutation<AgentConfig, AutoMateError, AgentConfigUpdate>({
    mutationFn: (update) => sendJson('/agent/config', 'PUT', update, (value): value is AgentConfig => Value.Check(AgentConfigResponseSchema, value)),
    onSuccess: (saved) => {
      queryClient.setQueryData(AGENT_CONFIG_KEY, saved);
      void queryClient.invalidateQueries({ queryKey: PROVIDER_CATALOG_KEY });
    },
  });
}

/** Open one real agent session and report the round trip. @returns A mutation over `POST /api/agent/test-connection`. @example useTestConnection().mutate() */
export function useTestConnection(): UseMutationResult<ConnectionTestResponse, AutoMateError, void> {
  return useMutation<ConnectionTestResponse, AutoMateError, void>({
    mutationFn: () => sendJson('/agent/test-connection', 'POST', undefined, (value): value is ConnectionTestResponse => Value.Check(ConnectionTestResponseSchema, value)),
  });
}

/** Turn any query or mutation failure into one plain-English line. @param error The rejected value. @returns A message safe to render; never a stack trace. @example messageFor(mutation.error) */
export function messageFor(error: unknown): string {
  if (error instanceof AutoMateError) return error.message;
  if (error instanceof Error && error.message.length > 0 && error.message.length < 300) return error.message;
  return 'Something went wrong. Check the server log for details.';
}

/** The error code carried by a failure, when it has one. @param error The rejected value. @returns The stable code, or the generic internal one. @example codeFor(mutation.error) */
export function codeFor(error: unknown): string {
  return error instanceof AutoMateError ? error.code : ERROR_CODES.INTERNAL_ERROR;
}
