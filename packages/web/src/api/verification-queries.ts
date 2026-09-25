import { Value } from '@sinclair/typebox/value';
import {
  ApprovalResponseSchema,
  ReviewResponseSchema,
  RunIntentResponseSchema,
  ScriptRunSchema,
  VerificationReportSchema,
  type ApprovalRequest,
  type ApprovalResponse,
  type ReviewRequest,
  type ReviewResponse,
  type RunIntentResponse,
  type ScriptRun,
  type VerificationReport,
} from '@automate/core';
import { getJson, sendJson } from './api-client';

/** The latest verification pass with its checks, in policy order, and its findings. */
export function getVerification(executionId: number): Promise<VerificationReport> {
  return getJson(`/executions/${executionId}/verification`, (value): value is VerificationReport => Value.Check(VerificationReportSchema, value));
}
/** What the gate shows, and the digest a decision must carry. */
export function getIntent(executionId: number): Promise<RunIntentResponse> {
  return getJson(`/executions/${executionId}/intent`, (value): value is RunIntentResponse => Value.Check(RunIntentResponseSchema, value));
}
/** The real run: status, exit code, captured output, and the declared outputs by filename. */
export function getRun(executionId: number): Promise<ScriptRun> {
  return getJson(`/executions/${executionId}/run`, (value): value is ScriptRun => Value.Check(ScriptRunSchema, value));
}
/** Approve or cancel exactly the intent that was shown. */
export function decideApproval(executionId: number, request: ApprovalRequest): Promise<ApprovalResponse> {
  return sendJson(`/executions/${executionId}/approval`, 'POST', request, (value): value is ApprovalResponse => Value.Check(ApprovalResponseSchema, value));
}
/** Accept a result, or reject it with what was wrong. */
export function submitReview(executionId: number, request: ReviewRequest): Promise<ReviewResponse> {
  return sendJson(`/executions/${executionId}/review`, 'POST', request, (value): value is ReviewResponse => Value.Check(ReviewResponseSchema, value));
}
/** Check the code again, for example after the runtime changed. */
export function requestVerification(executionId: number): Promise<{ status: string }> {
  return sendJson(`/executions/${executionId}/verify`, 'POST', {}, (value): value is { status: string } => typeof value === 'object' && value !== null && typeof (value as { status?: unknown }).status === 'string');
}
