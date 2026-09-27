import { Value } from '@sinclair/typebox/value';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CompatibilityResponseSchema, DeleteTemplateResponseSchema, SaveExecutionResponseSchema, SavePreviewResponseSchema, StartTemplateRunResponseSchema, ReplayResponseSchema, TaskHistoryPageSchema, TemplateDetailResponseSchema, TemplateListResponseSchema, TemplateRevisionDetailResponseSchema, type AsOf, type CompatibilityResponse, type RepairExecutionRequest, type SaveExecutionRequest, type SaveExecutionResponse, type SavePreviewResponse, type StartTemplateRepairRequest, type StartTemplateRunRequest, type StartTemplateRunResponse, type ReplayResponse, type DeleteTemplateResponse, type TaskHistoryPage, type TemplateDetailResponse, type TemplateListResponse, type TemplateRevisionDetailResponse } from '@automate/core';
import { getJson, sendJson } from './api-client';

const valid = <T>(schema: Parameters<typeof Value.Check>[0]) => (value: unknown): value is T => Value.Check(schema, value);
export const getSavePreview = (id: number) => getJson(`/executions/${id}/save-preview`, valid<SavePreviewResponse>(SavePreviewResponseSchema));
export const saveExecution = (id: number, request: SaveExecutionRequest) => sendJson(`/executions/${id}/save`, 'POST', request, valid<SaveExecutionResponse>(SaveExecutionResponseSchema));
export const getTemplates = (cursor?: number) => getJson(`/templates?limit=20${cursor ? `&cursor=${cursor}` : ''}`, valid<TemplateListResponse>(TemplateListResponseSchema));
export const useTemplates = () => useInfiniteQuery({ queryKey: ['templates'], initialPageParam: undefined as number | undefined, queryFn: ({ pageParam }) => getTemplates(pageParam), getNextPageParam: (last) => last.nextCursor ?? undefined });
export const getTemplate = (id: number) => getJson(`/templates/${id}`, valid<TemplateDetailResponse>(TemplateDetailResponseSchema));
export const useTemplate = (id: number) => useQuery({ queryKey: ['template', id], queryFn: () => getTemplate(id), enabled: id > 0 });
export const getTemplateRevision = (id: number) => getJson(`/template-revisions/${id}`, valid<TemplateRevisionDetailResponse>(TemplateRevisionDetailResponseSchema));
export const getTemplateRuns = (id: number, cursor?: string) => getJson(`/templates/${id}/runs?limit=20${cursor ? `&cursor=${cursor}` : ''}`, valid<TaskHistoryPage>(TaskHistoryPageSchema));
export const useTemplateRuns = (id: number) => useInfiniteQuery({ queryKey: ['template-runs', id], initialPageParam: undefined as string | undefined, queryFn: ({ pageParam }) => getTemplateRuns(id, pageParam), getNextPageParam: (last) => last.nextCursor ?? undefined });
export const deleteTemplate = (id: number) => sendJson(`/templates/${id}`, 'DELETE', undefined, valid<DeleteTemplateResponse>(DeleteTemplateResponseSchema));
export const getCompatibility = (id: number, uploadIds: readonly number[], asOfDate?: string, timeZone?: string) => {
  const query = new URLSearchParams({ uploadIds: uploadIds.join(',') });
  if (asOfDate) query.set('asOfDate', asOfDate);
  if (timeZone) query.set('timeZone', timeZone);
  return getJson(`/templates/${id}/compatibility?${query}`, valid<CompatibilityResponse>(CompatibilityResponseSchema));
};
export const getExecutionCompatibility = (id: number) => getJson(`/executions/${id}/compatibility`, valid<CompatibilityResponse>(CompatibilityResponseSchema));
export const startTemplateRun = (id: number, request: StartTemplateRunRequest) => sendJson(`/templates/${id}/runs`, 'POST', request, valid<StartTemplateRunResponse>(StartTemplateRunResponseSchema));
export const replayExecution = (id: number) => sendJson(`/executions/${id}/replay`, 'POST', undefined, valid<ReplayResponse>(ReplayResponseSchema));
export const startTemplateRepair = (id: number, request: StartTemplateRepairRequest) => sendJson(`/templates/${id}/repairs`, 'POST', request, valid<StartTemplateRunResponse>(StartTemplateRunResponseSchema));
export const repairExecution = (id: number, request: RepairExecutionRequest) => sendJson(`/executions/${id}/repair`, 'POST', request, valid<StartTemplateRunResponse>(StartTemplateRunResponseSchema));
export type CompatibilityInput = { uploadIds: readonly number[]; asOf?: AsOf };
