import { Value } from '@sinclair/typebox/value';
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import {
  AbortResponseSchema,
  AutoMateError,
  ConversationEventPageSchema,
  CreateTaskResponseSchema,
  ExecutionSummarySchema,
  TaskResponseSchema,
  type ConversationEventPage,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type ExecutionSummary,
  type TaskResponse,
} from '@automate/core';
import { getJson, sendJson } from './api-client';

/** Create a task and immediately receive its first execution; attached upload ids are claimed atomically. */
export function useCreateTask(): UseMutationResult<
  CreateTaskResponse,
  AutoMateError,
  CreateTaskRequest
> {
  return useMutation({
    mutationFn: (body) =>
      sendJson('/tasks', 'POST', body, (value): value is CreateTaskResponse =>
        Value.Check(CreateTaskResponseSchema, value),
      ),
  });
}

/** Abort one active execution and refresh its cached summary. */
export function useAbortExecution(
  executionId: number,
): UseMutationResult<ExecutionSummary, AutoMateError, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      sendJson(
        `/executions/${executionId}/abort`,
        'POST',
        undefined,
        (value): value is ExecutionSummary =>
          Value.Check(AbortResponseSchema, value),
      ),
    onSuccess: (execution) =>
      client.setQueryData(['execution', executionId], execution),
  });
}

export function getExecution(executionId: number): Promise<ExecutionSummary> {
  return getJson(
    `/executions/${executionId}`,
    (value): value is ExecutionSummary =>
      Value.Check(ExecutionSummarySchema, value),
  );
}
export function getConversationEvents(
  executionId: number,
  afterSeq = 0,
  limit = 200,
): Promise<ConversationEventPage> {
  return getJson(
    `/executions/${executionId}/events?afterSeq=${afterSeq}&limit=${limit}`,
    (value): value is ConversationEventPage =>
      Value.Check(ConversationEventPageSchema, value),
  );
}
export function getTask(taskId: number): Promise<TaskResponse> {
  return getJson(`/tasks/${taskId}`, (value): value is TaskResponse =>
    Value.Check(TaskResponseSchema, value),
  );
}
