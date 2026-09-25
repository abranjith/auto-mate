import { Value } from '@sinclair/typebox/value';
import { ClarificationListResponseSchema, ClarificationSchema, type Clarification, type ClarificationAnswerRequest } from '@automate/core';
import { getJson, sendJson } from './api-client';

export async function getClarifications(executionId: number): Promise<readonly Clarification[]> {
  const result = await getJson(`/executions/${executionId}/clarifications`, (value): value is { clarifications: Clarification[] } => Value.Check(ClarificationListResponseSchema, value));
  return result.clarifications;
}
export function answerClarification(id: number, body: ClarificationAnswerRequest): Promise<Clarification> {
  return sendJson(`/clarifications/${id}/answers`, 'POST', body, (value): value is Clarification => Value.Check(ClarificationSchema, value));
}
