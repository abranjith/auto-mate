import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { Value } from '@sinclair/typebox/value';
import { CodeVersionDetailSchema, CodeVersionListResponseSchema, CreateTaskResponseSchema, GenerationAttemptListResponseSchema, SyntheticFixtureListResponseSchema } from '@automate/core';
import { createGenerationHarness, finalizeStep, writeSteps, MAIN_PY, type GenerationHarness, type HarnessOptions } from './support/generation-harness';
import type { FakeAgentStep } from '../agent/testing/fake-agent-provider';

const harnesses: GenerationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });
const RUN: FakeAgentStep = { call: { tool: 'run_tests', args: {} } };
const FAILED = { result: { outcome: 'failed' as const, exitCode: 1, stdout: 'Traceback (most recent call last):\n  File "main.py", line 5, in main\nKeyError: \'amount\'\nnoise line\n1 failed, 2 passed in 0.1s' } };
const JSON_HEADERS = { 'content-type': 'application/json' };

/** A run that fails once then passes and finalizes, served over HTTP. */
async function served(options: HarnessOptions = {}) {
  const harness = await createGenerationHarness({ pythonRuns: [FAILED, {}], steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, ...writeSteps(upload!.storedFilename, `${MAIN_PY}# fixed\n`), RUN, finalizeStep(upload!.storedFilename)], ...options });
  harnesses.push(harness);
  await harness.run();
  const { base } = await harness.serve();
  const bodies: string[] = [];
  const get = async (path: string) => { const response = await fetch(`${base}${path}`); const text = await response.text(); bodies.push(text); return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, headers: response.headers }; };
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => { const response = await fetch(`${base}${path}`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) }); const text = await response.text(); bodies.push(text); return { status: response.status, body: JSON.parse(text) as Record<string, unknown> }; };
  return { harness, get, post, bodies };
}
const executionCount = (harness: GenerationHarness) => (harness.store.connection.client.prepare('SELECT count(*) AS count FROM execution').get() as { count: number }).count;
async function settledAgain(harness: GenerationHarness, executionId: number) {
  for (let tries = 0; tries < 200 && !['completed', 'failed', 'aborted'].includes(harness.repos.executions.getById(executionId)!.status); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('generation routes', () => {
  it('lists versions newest attempt first with digests and outcomes, and no file content', async () => {
    const { harness, get } = await served();
    const { status, body } = await get(`/api/executions/${harness.execution.id}/code-versions`);
    expect(status).toBe(200);
    expect(Value.Check(CodeVersionListResponseSchema, body)).toBe(true);
    const versions = body.codeVersions as { attempt: number; status: string; contentDigest: string; isFinal: boolean; files: Record<string, unknown>[] }[];
    expect(versions.map(({ attempt, status: state, isFinal }) => [attempt, state, isFinal])).toEqual([[2, 'tested_pass', true], [1, 'tested_fail', false]]);
    expect(versions.every(({ contentDigest }) => /^[0-9a-f]{64}$/.test(contentDigest))).toBe(true);
    expect(versions.flatMap(({ files }) => files).every((file) => !('content' in file))).toBe(true);
  });

  it('returns one version with every file\'s content byte-identical to the stored row', async () => {
    const { harness, get } = await served();
    const final = harness.repos.versions.findFinal(harness.execution.id)!;
    const { body } = await get(`/api/code-versions/${final.id}`);
    expect(Value.Check(CodeVersionDetailSchema, body)).toBe(true);
    const rows = harness.repos.versions.listFiles([final.id]);
    expect((body.files as { path: string; content: string }[]).map(({ path, content }) => [path, content])).toEqual(rows.map(({ path, content }) => [path, content]));
    expect(body).toMatchObject({ isFinal: true, declaredOutputs: [{ filename: 'totals.csv', type: 'csv' }] });
  });

  it('answers an unknown version with CODE_VERSION_NOT_FOUND and the correlation id it sent', async () => {
    const { get } = await served();
    const { status, body, headers } = await get('/api/code-versions/9999');
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'CODE_VERSION_NOT_FOUND', correlationId: headers.get('x-correlation-id') } });
    expect((await get('/api/code-versions/abc')).status).toBe(400);
    expect((await get('/api/executions/9999/attempts')).body).toMatchObject({ error: { code: 'EXECUTION_NOT_FOUND' } });
  });

  it('lists attempts with the filtered diagnostics that were sent and the withheld-line count, and nothing for a pass', async () => {
    const { harness, get } = await served();
    const { body } = await get(`/api/executions/${harness.execution.id}/attempts`);
    expect(Value.Check(GenerationAttemptListResponseSchema, body)).toBe(true);
    const [failed, passed] = body.attempts as { status: string; diagnostics: string | null; droppedLineCount: number | null }[];
    expect(failed).toMatchObject({ status: 'failed', diagnostics: expect.stringContaining('KeyError: <str len=6>'), droppedLineCount: expect.any(Number) });
    expect(failed!.droppedLineCount).toBeGreaterThan(0);
    expect(passed).toMatchObject({ status: 'passed', diagnostics: null, droppedLineCount: null });
  });

  it('lists fixtures with at most 20 preview rows and the recorded counts', async () => {
    const { harness, get } = await served();
    const { body } = await get(`/api/executions/${harness.execution.id}/fixtures`);
    expect(Value.Check(SyntheticFixtureListResponseSchema, body)).toBe(true);
    const [fixture] = body.fixtures as { fileName: string; rowCount: number; sampleRowCount: number; preview: { header: string[]; rows: string[][] }[] }[];
    expect(fixture).toMatchObject({ fileName: harness.upload!.storedFilename, rowCount: 200, sampleRowCount: 10 });
    expect(fixture!.preview[0]!.header).toEqual(['order_id', 'region', 'amount', 'ref']);
    expect(fixture!.preview[0]!.rows).toHaveLength(20);
  });

  it('never returns an absolute filesystem path from any route', async () => {
    const { harness, get, bodies } = await served();
    const id = harness.execution.id;
    await get(`/api/executions/${id}/code-versions`);
    await get(`/api/code-versions/${harness.repos.versions.findFinal(id)!.id}`);
    await get(`/api/executions/${id}/attempts`);
    await get(`/api/executions/${id}/fixtures`);
    const all = bodies.join('\n');
    for (const root of [harness.store.root, harness.store.root.replace(/\\/g, '\\\\'), tmpdir()]) expect(all).not.toContain(root);
    expect(all).not.toMatch(/[A-Za-z]:\\\\/);
  });
});

describe('POST /api/executions/:id/retry', () => {
  function failing() {
    return { pythonRuns: [FAILED, FAILED, FAILED, {}], steps: (upload: Parameters<NonNullable<HarnessOptions['steps']>>[0]) => [...Array.from({ length: 3 }, () => [...writeSteps(upload!.storedFilename), RUN]).flat()] } satisfies HarnessOptions;
  }

  it('creates and starts one linked retry of a failed run, with the guidance as the person\'s words', async () => {
    const { harness, post, get } = await served(failing());
    expect(harness.repos.executions.getById(harness.execution.id)!.status).toBe('failed');
    const { status, body } = await post(`/api/executions/${harness.execution.id}/retry`, { guidance: '  Group by month, not by day.  ' });
    expect(status).toBe(201);
    expect(Value.Check(CreateTaskResponseSchema, body)).toBe(true);
    const newId = (body.execution as { id: number }).id;
    expect(harness.repos.executions.getById(newId)).toMatchObject({ trigger: 'rerun', retryOfExecutionId: harness.execution.id, guidance: 'Group by month, not by day.' });
    await settledAgain(harness, newId);
    const events = (await get(`/api/executions/${newId}/events`)).body.events as { type: string; text?: string }[];
    expect(events.filter(({ type }) => type === 'user_prompt').map(({ text }) => text)).toEqual([harness.task.description, 'Group by month, not by day.']);
    expect(harness.repos.executions.getById(harness.execution.id)!.status).toBe('failed');
  });

  it('refuses a run that is still generating, creating nothing', async () => {
    const { harness, post } = await served();
    const busy = harness.repos.executions.createRetry(harness.execution.id, null);
    harness.repos.executions.markStarted(busy.id);
    const before = executionCount(harness);
    const { status, body } = await post(`/api/executions/${busy.id}/retry`, {});
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'EXECUTION_NOT_RETRYABLE' } });
    expect(executionCount(harness)).toBe(before);
  });

  it('reopens the disclosure gate when the model changed since approval, creating nothing', async () => {
    const { harness, post } = await served(failing());
    harness.model.value = 'a-different-model';
    const before = executionCount(harness);
    const { status, body } = await post(`/api/executions/${harness.execution.id}/retry`, { guidance: 'x' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: { code: 'DISCLOSURE_CONSENT_STALE' } });
    expect(executionCount(harness)).toBe(before);
  });

  it('rejects over-long guidance and unknown fields', async () => {
    const { harness, post } = await served(failing());
    expect((await post(`/api/executions/${harness.execution.id}/retry`, { guidance: 'x'.repeat(3_000) })).body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect((await post(`/api/executions/${harness.execution.id}/retry`, { guidance: 'x', extra: true })).body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects a foreign Origin before anything is written', async () => {
    const { harness, post } = await served(failing());
    const before = executionCount(harness);
    const { status, body } = await post(`/api/executions/${harness.execution.id}/retry`, {}, { origin: 'http://evil.example' });
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    expect(executionCount(harness)).toBe(before);
  });

  it('allows two concurrent retries of one run, each linked to the same source', async () => {
    const { harness, post } = await served(failing());
    const [first, second] = await Promise.all([post(`/api/executions/${harness.execution.id}/retry`, {}), post(`/api/executions/${harness.execution.id}/retry`, {})]);
    const ids = [first, second].map(({ body }) => (body.execution as { id: number }).id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(harness.repos.executions.getById(id)!.retryOfExecutionId).toBe(harness.execution.id);
    for (const id of ids) await settledAgain(harness, id);
  });
});
