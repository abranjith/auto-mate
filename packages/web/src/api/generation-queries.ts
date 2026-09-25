import { Value } from '@sinclair/typebox/value';
import {
  CodeVersionDetailSchema,
  CodeVersionListResponseSchema,
  CreateTaskResponseSchema,
  GenerationAttemptListResponseSchema,
  SyntheticFixtureListResponseSchema,
  type CodeVersionDetail,
  type CodeVersionListResponse,
  type CreateTaskResponse,
  type GenerationAttemptListResponse,
  type SyntheticFixture,
  type SyntheticFixtureListResponse,
} from '@automate/core';
import { getJson, sendJson } from './api-client';

/** A run's versions, newest attempt first, without file content. */
export async function getCodeVersions(executionId: number): Promise<CodeVersionListResponse['codeVersions']> {
  return (await getJson(`/executions/${executionId}/code-versions`, (value): value is CodeVersionListResponse => Value.Check(CodeVersionListResponseSchema, value))).codeVersions;
}
/** One version with every file's content, fetched only when a person opens it. */
export function getCodeVersion(id: number): Promise<CodeVersionDetail> {
  return getJson(`/code-versions/${id}`, (value): value is CodeVersionDetail => Value.Check(CodeVersionDetailSchema, value));
}
/** A run's attempts with the filtered diagnostics that were sent, plus the limits it runs under. */
export function getAttempts(executionId: number): Promise<GenerationAttemptListResponse> {
  return getJson(`/executions/${executionId}/attempts`, (value): value is GenerationAttemptListResponse => Value.Check(GenerationAttemptListResponseSchema, value));
}
/** The synthetic stand-ins a run tested against, with a bounded preview. */
export async function getFixtures(executionId: number): Promise<readonly SyntheticFixture[]> {
  return (await getJson(`/executions/${executionId}/fixtures`, (value): value is SyntheticFixtureListResponse => Value.Check(SyntheticFixtureListResponseSchema, value))).fixtures;
}
/** Start a new run of a finished run's task, with the person's guidance. */
export function retryExecution(executionId: number, guidance: string): Promise<CreateTaskResponse> {
  return sendJson(`/executions/${executionId}/retry`, 'POST', guidance.trim() ? { guidance } : {}, (value): value is CreateTaskResponse => Value.Check(CreateTaskResponseSchema, value));
}

const fixtureCache = new Map<number, Promise<readonly SyntheticFixture[]>>();
/** Fixtures change only when a run starts, so one request per run serves every attempt's note. */
export function getFixturesOnce(executionId: number): Promise<readonly SyntheticFixture[]> {
  let pending = fixtureCache.get(executionId);
  if (!pending) {
    pending = getFixtures(executionId).catch((cause: unknown) => { fixtureCache.delete(executionId); throw cause; });
    fixtureCache.set(executionId, pending);
  }
  return pending;
}
