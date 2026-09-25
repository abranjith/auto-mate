import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assemblePromptContext, renderCodeContract } from '@automate/core';
import { SCRIPT_DEPENDENCY_SET } from '../../execution/dependency-policy';
import { GENERATION_SYSTEM_PROMPT } from '../../generation/code-generation-run-strategy';
import { createGenerationHarness, type GenerationHarness, type HarnessOptions } from '../support/generation-harness';
import { HIGH_CARDINALITY_SENTINEL, ROW_11_SENTINEL } from '../support/generation-fixtures';

const harnesses: GenerationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });
async function harness(options: HarnessOptions = {}) {
  const created = await createGenerationHarness(options);
  harnesses.push(created);
  return created;
}
const fixturesDir = (h: GenerationHarness) => path.join(h.store.paths.scriptsDir, String(h.execution.id), 'fixtures');
const contractFor = (h: GenerationHarness) => renderCodeContract({ platform: 'linux', pythonVersion: '3.12.4', dependencies: SCRIPT_DEPENDENCY_SET.map(({ name }) => name), inputFiles: [{ filename: h.upload!.storedFilename, format: 'csv', sheets: [] }], attemptLimit: 3 });

describe('CodeGenerationRunStrategy', () => {
  it('sends exactly the consent snapshot, the person\'s words, and the contract — reconstructed byte for byte', async () => {
    const h = await harness();
    await h.run();
    const [prompt] = h.provider.sessions[0]!.prompts;
    const expected = assemblePromptContext({ userPrompt: h.task.description, disclosure: { text: h.consent!.payloadSnapshot, consentId: h.consent!.id }, appText: [contractFor(h)] }).text;
    expect(prompt).toBe(expected);
    expect(prompt!.indexOf('[USER REQUEST]')).toBeLessThan(prompt!.indexOf('[APPROVED FILE DESCRIPTION]'));
    expect(prompt!.indexOf('[APPROVED FILE DESCRIPTION]')).toBeLessThan(prompt!.indexOf('CODE CONTRACT'));
    expect(prompt).not.toContain(ROW_11_SENTINEL);
    expect(prompt).not.toContain(HIGH_CARDINALITY_SENTINEL);
    expect(prompt!.replace(/\d+-sales\.csv/g, '<stored>.csv')).toMatchSnapshot();
  });

  it('records exactly one context transmission, before the provider opens', async () => {
    const h = await harness();
    await h.run();
    expect(h.repos.transmissions.listByExecution(h.execution.id).map(({ kind }) => kind)).toEqual(['context']);
  });

  it('registers exactly five tools and names them in the system prompt', async () => {
    const h = await harness();
    await h.run();
    const opened = h.provider.opened[0]!;
    expect(opened.customTools!.map(({ name }) => name)).toEqual(['request_clarification', 'write_script', 'write_test', 'run_tests', 'finalize_script']);
    expect(opened.systemPrompt).toBe(GENERATION_SYSTEM_PROMPT);
    for (const name of ['write_script', 'write_test', 'run_tests', 'finalize_script', 'request_clarification']) expect(opened.systemPrompt).toContain(name);
  });

  it('writes one fixture per attached upload, named like the upload', async () => {
    const h = await harness();
    await h.run();
    expect(existsSync(path.join(fixturesDir(h), h.upload!.storedFilename))).toBe(true);
    expect(h.repos.fixtures.listByExecution(h.execution.id)).toHaveLength(1);
  });

  it('stops with DISCLOSURE_CONSENT_REQUIRED when consent was revoked: the provider is never opened and no fixture is written', async () => {
    const h = await harness();
    h.repos.consents.revoke(h.consent!.id);
    const row = await h.run();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'DISCLOSURE_CONSENT_REQUIRED' });
    expect(h.provider.opened).toHaveLength(0);
    expect(existsSync(fixturesDir(h))).toBe(false);
    expect(h.repos.fixtures.listByExecution(h.execution.id)).toEqual([]);
    expect(h.repos.transmissions.listByExecution(h.execution.id)).toEqual([]);
  });

  it('stops with DISCLOSURE_CONSENT_STALE when the model changed: the provider is never opened and no fixture is written', async () => {
    const h = await harness();
    h.model.value = 'another-model';
    const row = await h.run();
    expect(row).toMatchObject({ status: 'failed', errorCode: 'DISCLOSURE_CONSENT_STALE' });
    expect(h.provider.opened).toHaveLength(0);
    expect(existsSync(fixturesDir(h))).toBe(false);
  });

  it('adds a retry\'s guidance to the person\'s words in the same prompt, and changes nothing when there is none', async () => {
    const h = await harness();
    const retry = h.repos.executions.createRetry(h.execution.id, 'Group by month, not by day.');
    await h.run(retry);
    const [prompt] = h.provider.sessions[0]!.prompts;
    const userSection = prompt!.split('\n\n[APPROVED FILE DESCRIPTION]')[0];
    expect(userSection).toBe(`[USER REQUEST]\n${h.task.description}\n\nGroup by month, not by day.`);
    expect(prompt).toContain('added guidance');
    const plain = await harness();
    await plain.run();
    expect(plain.provider.sessions[0]!.prompts[0]).not.toContain('guidance');
  });

  it('passes a text-only task straight through, with no fixture and no generation tools', async () => {
    const h = await harness({ files: [] });
    await h.run();
    expect(h.provider.sessions[0]!.prompts).toEqual([h.task.description]);
    expect(h.provider.opened[0]!.customTools!.map(({ name }) => name)).toEqual(['request_clarification']);
    expect(existsSync(fixturesDir(h))).toBe(false);
  });
});
