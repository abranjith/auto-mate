import { afterEach, describe, expect, it } from 'vitest';
import { assemblePromptContext } from '@automate/core';
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
});
