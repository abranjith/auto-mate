import { afterEach, describe, expect, it } from 'vitest';
import { createGenerationHarness, finalizeStep, writeSteps, MAIN_PY, type GenerationHarness, type HarnessOptions } from '../../support/generation-harness';
import type { FakeAgentStep } from '../../../agent/testing/fake-agent-provider';

const harnesses: GenerationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });
async function run(options: HarnessOptions) {
  const harness = await createGenerationHarness(options);
  harnesses.push(harness);
  const row = await harness.run();
  const results = harness.provider.sessions[0]!.toolResults.filter(({ tool }) => tool === 'finalize_script');
  return { harness, row, results };
}
const RUN: FakeAgentStep = { call: { tool: 'run_tests', args: {} } };
const FAILED = { result: { outcome: 'failed' as const, exitCode: 1, stdout: '1 failed, 2 passed in 0.1s' } };
const details = (output: unknown) => (output as { details: Record<string, unknown> }).details;
const text = (output: unknown) => (output as { content: { text: string }[] }).content[0]!.text;
const finalCount = (harness: GenerationHarness) => (harness.store.connection.client.prepare('SELECT count(*) AS count FROM code_version WHERE execution_id = ? AND is_final = 1').get(harness.execution.id) as { count: number }).count;

describe('finalize_script', () => {
  it('finalizes the tested version with its contracts and summary, and the run completes', async () => {
    const { harness, row, results } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename)] });
    const final = harness.repos.versions.findFinal(harness.execution.id)!;
    expect(details(results[0]!.output)).toEqual({ codeVersionId: final.id, digest: final.contentDigest, attempt: 1, testsPassed: true });
    expect(final).toMatchObject({ isFinal: true, entrypoint: 'main.py', summary: 'Totals sales by region.', testsPassed: true });
    expect(JSON.parse(final.declaredInputs!)).toEqual([{ fileRole: harness.upload!.storedFilename, requiredColumns: [{ name: 'region', type: 'string' }] }]);
    expect(JSON.parse(final.declaredOutputs!)).toEqual([{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Sales per region.' }]);
    expect(row.status).toBe('completed');
    expect(finalCount(harness)).toBe(1);
  });

  it('finalizes after a failed attempt and a passing one: exactly one final version', async () => {
    const { harness } = await run({ pythonRuns: [FAILED, {}], steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, ...writeSteps(upload!.storedFilename, `${MAIN_PY}# repaired\n`), RUN, finalizeStep(upload!.storedFilename)] });
    expect(finalCount(harness)).toBe(1);
    expect(harness.repos.versions.findFinal(harness.execution.id)!.attempt).toBe(2);
  });

  it('finalizes after three failed attempts and records tests_passed = 0 — it is not a gate', async () => {
    const { harness, row, results } = await run({ pythonRuns: [FAILED, FAILED, FAILED], steps: (upload) => [...Array.from({ length: 3 }, (_, index) => [...writeSteps(upload!.storedFilename, `${MAIN_PY}# ${index}\n`), RUN]).flat(), RUN, finalizeStep(upload!.storedFilename)] });
    expect(results[0]!.isError).toBe(false);
    expect(harness.repos.versions.findFinal(harness.execution.id)).toMatchObject({ attempt: 3, testsPassed: false, isFinal: true });
    expect(row).toMatchObject({ status: 'failed', errorCode: 'GENERATION_ATTEMPTS_EXHAUSTED' });
    expect(harness.transcript().filter(({ type }) => type === 'generation_settled')).toMatchObject([{ outcome: 'exhausted', codeVersionId: expect.any(Number) }]);
  });

  it('seals an open draft first and finalizes that version, untested', async () => {
    const { harness, row } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), finalizeStep(upload!.storedFilename)] });
    const final = harness.repos.versions.findFinal(harness.execution.id)!;
    expect(final).toMatchObject({ status: 'sealed', attempt: 1, testsPassed: null, isFinal: true });
    expect(harness.transcript().some(({ type }) => type === 'code_version_sealed')).toBe(true);
    expect(row.status).toBe('completed');
    expect(harness.transcript().find(({ type }) => type === 'generation_settled')).toMatchObject({ outcome: 'finalized', summary: expect.stringContaining('which was never tested') });
  });

  it.each([
    ['test_main.py', 'reserved for tests'],
    ['missing.py', 'is not a script in attempt 1. Scripts in it: main.py'],
  ])('refuses the entrypoint %j with an actionable error and finalizes nothing', async (entrypoint, hint) => {
    const { harness, results } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename, { entrypoint })] });
    expect(results[0]!.isError).toBe(true);
    expect(text(results[0]!.output)).toContain(hint);
    expect(finalCount(harness)).toBe(0);
  });

  it('rejects a declared output type outside the artifact list at the parameter schema', async () => {
    const { results, harness } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename, { declaredOutputs: [{ filename: 'x.svg', type: 'svg', title: 'X', description: '' }] })] });
    expect(results[0]!.isError).toBe(true);
    expect(finalCount(harness)).toBe(0);
  });

  it('refuses a declared input column no attached file has, naming it and the columns that exist', async () => {
    const { results, harness } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename, { declaredInputs: [{ fileRole: upload!.storedFilename, requiredColumns: [{ name: 'regoin', type: 'string' }] }] })] });
    expect(results[0]!.isError).toBe(true);
    expect(text(results[0]!.output)).toBe('Declared input column "regoin" is not in any attached file. Columns that exist: "order_id", "region", "amount", "ref".');
    expect(finalCount(harness)).toBe(0);
  });

  it('refuses a second finalization and leaves the first intact', async () => {
    const { results, harness } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename), finalizeStep(upload!.storedFilename, { summary: 'Something else.' })] });
    expect(results.map(({ isError }) => isError)).toEqual([false, true]);
    expect(text(results[1]!.output)).toContain('cannot be finalized twice');
    expect(harness.repos.versions.findFinal(harness.execution.id)!.summary).toBe('Totals sales by region.');
  });

  it('refuses when nothing has been written yet', async () => {
    const { results } = await run({ steps: (upload) => [finalizeStep(upload!.storedFilename)] });
    expect(text(results[0]!.output)).toContain('no version to finalize yet');
  });

  it('carries the version id and digest in generation_settled, never the code; a hostile summary is stored verbatim', async () => {
    const hostile = '<script>alert(1)</script> totals';
    const { harness } = await run({ steps: (upload) => [...writeSteps(upload!.storedFilename), RUN, finalizeStep(upload!.storedFilename, { summary: hostile })] });
    const final = harness.repos.versions.findFinal(harness.execution.id)!;
    expect(final.summary).toBe(hostile);
    const settled = harness.transcript().find(({ type }) => type === 'generation_settled');
    expect(settled).toMatchObject({ outcome: 'finalized', codeVersionId: final.id, digest: final.contentDigest });
    expect(JSON.stringify(settled)).not.toContain('pandas');
  });
});
