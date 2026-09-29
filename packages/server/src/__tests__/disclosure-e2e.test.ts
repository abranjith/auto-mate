import { afterEach, describe, expect, it } from 'vitest';
import { assemblePromptContext } from '@automate/core';
import { HistoryRepository } from '../db/repositories/history-repository';
import type { FakeAgentStep } from '../agent/testing/fake-agent-provider';
import {
  createGenerationHarness,
  finalizeStep,
  writeSteps,
  type GenerationHarness,
} from './support/generation-harness';
import {
  HIGH_CARDINALITY_SENTINEL,
  ROW_11_SENTINEL,
} from './support/generation-fixtures';

const harnesses: GenerationHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

async function harness(options: Parameters<typeof createGenerationHarness>[0] = {}) {
  const created = await createGenerationHarness(options);
  harnesses.push(created);
  return created;
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The expected disclosure state did not appear.');
}

const clarify: FakeAgentStep = {
  call: {
    tool: 'request_clarification',
    callId: 'clarify-1',
    args: {
      questions: [{
        question: 'Should totals include returns?',
        rationale: 'Including returns changes the reported total.',
        impact: 'meaning',
        options: [{ value: 'include', label: 'Include returns' }, { value: 'exclude', label: 'Exclude returns' }],
        proposedDefault: 'include',
      }],
    },
  },
};

describe('disclosure and clarification end to end', () => {
  it('takes a typed answer over HTTP and follows up in the same text-only run', async () => {
    let releaseFollow!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFollow = resolve; });
    const follow = { questions: [{ question: 'What time do you mean?', rationale: 'The time changes the result.', impact: 'meaning', proposedDefault: 'Use noon', followUpOf: 0 }] };
    const logLines: string[] = [];
    const h = await harness({ files: [], logLines, steps: () => [clarify, { until: gate }, { call: { tool: 'request_clarification', callId: 'follow-1', args: follow } }, { event: { type: 'assistant_text', text: 'Done.', at: new Date().toISOString() } }] });
    const { base } = await h.serve();
    const run = h.run();
    const original = await eventually(() => h.repos.clarifications.listByExecution(h.execution.id).find(({ status }) => status === 'pending'));
    const answer = await fetch(`${base}/api/clarifications/${original.id}/answers`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ answers: [{ questionId: original.questions[0]!.id, value: '  about 3 hours after eating  ' }] }) });
    expect(answer.status).toBe(200);
    expect((await answer.json() as { questions: { answerKind: string; followUpOfQuestionId: number | null }[] }).questions[0]).toMatchObject({ answerKind: 'own_words', followUpOfQuestionId: null });
    follow.questions[0]!.followUpOf = original.questions[0]!.id;
    releaseFollow();
    const second = await eventually(() => h.repos.clarifications.listByExecution(h.execution.id).find(({ callId }) => callId === 'follow-1'));
    expect(second.status).toBe('pending');
    expect(second.questions[0]?.followUpOfQuestionId).toBe(original.questions[0]!.id);
    const answerSecond = await fetch(`${base}/api/clarifications/${second.id}/answers`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ answers: [{ questionId: second.questions[0]!.id, value: '3 p.m.' }] }) });
    expect(answerSecond.status).toBe(200);
    const listed = await fetch(`${base}/api/executions/${h.execution.id}/clarifications`);
    expect((await listed.json() as { clarifications: { questions: { answerKind: string; followUpOfQuestionId: number | null }[] }[] }).clarifications[1]?.questions[0]).toMatchObject({ answerKind: 'own_words', followUpOfQuestionId: original.questions[0]!.id });
    expect((await run).status).toBe('completed');
    const results = h.provider.sessions[0]!.toolResults.filter(({ tool }) => tool === 'request_clarification');
    expect(results).toHaveLength(2);
    expect(results[0]?.output).toMatchObject({ details: { answers: [{ answeredWith: 'own_words', answer: 'about 3 hours after eating' }], guidance: expect.stringContaining('followUpOf') } });
    expect(h.repos.clarifications.countAgentQuestions(h.execution.id)).toBe(1);
    expect(new HistoryRepository(h.store.connection).getRunRecord(h.execution.id)?.questions?.followUps).toBe(1);
    const events = h.transcript();
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter(({ type }) => type === 'clarification_requested')).toHaveLength(2);
    expect(events.filter(({ type }) => type === 'clarification_answered')).toHaveLength(2);
    expect(events.some(({ type }) => type === 'assistant_text')).toBe(true);
    expect(logLines.join('')).not.toContain('Should totals include returns?');
    expect(logLines.join('')).not.toContain('about 3 hours after eating');
  });
  it('sends only the approved snapshot, parks for an answer, resumes, and records one context receipt', async () => {
    const h = await harness({
      pythonRuns: [{}],
      steps: (upload) => [clarify, ...writeSteps(upload!.storedFilename), { call: { tool: 'run_tests', args: {} } }, finalizeStep(upload!.storedFilename)],
    });
    const settled = h.run();
    const batch = await eventually(() => h.repos.clarifications.listByExecution(h.execution.id).find(({ status }) => status === 'pending'));
    expect(h.repos.executions.getById(h.execution.id)?.status).toBe('waiting');
    h.clarificationService.answer(batch.id, [{ questionId: batch.questions[0]!.id, value: 'exclude' }]);
    expect((await settled).status).toBe('completed');

    const prompt = h.provider.sessions[0]!.prompts[0]!;
    const expectedPrefix = assemblePromptContext({
      userPrompt: h.task.description,
      disclosure: { text: h.consent!.payloadSnapshot, consentId: h.consent!.id },
      appText: [],
    }).text;
    expect(prompt.startsWith(expectedPrefix)).toBe(true);
    expect(prompt.split(h.consent!.payloadSnapshot)).toHaveLength(2);
    for (const sentinel of [ROW_11_SENTINEL, HIGH_CARDINALITY_SENTINEL]) expect(prompt).not.toContain(sentinel);

    const receipts = h.repos.transmissions.listByExecution(h.execution.id);
    expect(receipts.map(({ kind }) => kind)).toEqual(['context']);
    expect(receipts[0]).toMatchObject({ consentId: h.consent!.id, payloadDigest: h.consent!.payloadDigest, payloadSnapshot: null });

    const events = h.transcript();
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    const kinds = events.map(({ type }) => type);
    expect(kinds.indexOf('clarification_requested')).toBeLessThan(kinds.indexOf('clarification_answered'));
    expect(kinds.indexOf('clarification_answered')).toBeLessThan(kinds.lastIndexOf('state_changed'));
  });

  it('never opens the provider after consent revocation or a model change', async () => {
    const revoked = await harness({ steps: () => [] });
    revoked.repos.consents.revoke(revoked.consent!.id);
    expect(await revoked.run()).toMatchObject({ status: 'failed', errorCode: 'DISCLOSURE_CONSENT_REQUIRED' });
    expect(revoked.provider.opened).toHaveLength(0);

    const changed = await harness({ steps: () => [] });
    changed.model.value = 'different-model';
    expect(await changed.run()).toMatchObject({ status: 'failed', errorCode: 'DISCLOSURE_CONSENT_STALE' });
    expect(changed.provider.opened).toHaveLength(0);
  });

  it('refuses unscoped diagnostics before any provider session or receipt exists', async () => {
    const h = await harness({ scopeDiagnostics: false, steps: () => [] });
    expect(() => h.inner.recordDiagnosticTransmission(h.execution.id, "ValueError: bad 'private value'")).toThrow(/not approved/i);
    expect(h.provider.opened).toHaveLength(0);
    expect(h.repos.transmissions.listByExecution(h.execution.id)).toEqual([]);
  });

  it('covers two uploads with one consent and one context transmission', async () => {
    const h = await harness({
      files: [
        { name: 'one.csv', bytes: Buffer.from('a,b\n1,x\n'), format: 'csv' },
        { name: 'two.csv', bytes: Buffer.from('c,d\n2,y\n'), format: 'csv' },
      ],
      steps: () => [],
    });
    await h.run();
    expect(JSON.parse(h.consent!.uploadIds)).toEqual(h.uploads.map(({ id }) => id));
    expect(h.repos.transmissions.listByExecution(h.execution.id).map(({ kind }) => kind)).toEqual(['context']);
  });

  it('renews a changed recipient for an existing task only with that task\'s files', async () => {
    const h = await harness({ steps: () => [] });
    h.model.value = 'new-model';
    expect(() => h.disclosure.verifyForTransmission(h.task.id, 'context')).toThrow(/changed|stale/i);
    const uploadIds = h.uploads.map(({ id }) => id);
    const preview = h.disclosure.buildPreview(uploadIds);
    const renewed = h.disclosure.grantConsent({ taskId: h.task.id, uploadIds, payloadDigest: preview.digest, scopeDiagnostics: true });
    expect(renewed.taskId).toBe(h.task.id);
    expect(h.disclosure.verifyForTransmission(h.task.id, 'context').id).toBe(renewed.id);
    const other = h.repos.tasks.createWithExecution('Other task');
    expect(() => h.disclosure.grantConsent({ taskId: other.task.id, uploadIds, payloadDigest: preview.digest, scopeDiagnostics: true })).toThrow(/belong to the task/i);
    expect(h.repos.consents.findLiveForTask(other.task.id)).toBeUndefined();
  });
});
