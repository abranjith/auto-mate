import { afterEach, describe, expect, it } from 'vitest';
import { createGenerationHarness, finalizeStep, type GenerationHarness } from '../../support/generation-harness';
import type { FakeAgentStep } from '../../../agent/testing/fake-agent-provider';

const harnesses: GenerationHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.dispose())); });

async function runSteps(steps: readonly FakeAgentStep[]) {
  const harness = await createGenerationHarness({ steps: () => steps });
  harnesses.push(harness);
  await harness.run();
  const results = harness.provider.sessions[0]!.toolResults;
  const files = harness.store.connection.client.prepare('SELECT path, role, content FROM code_file ORDER BY id').all() as { path: string; role: string; content: string }[];
  return { harness, results, files };
}
const write = (tool: 'write_script' | 'write_test', path: string, content: string): FakeAgentStep => ({ call: { tool, args: { path, content } } });
const details = (output: unknown) => (output as { details: unknown }).details;
const text = (output: unknown) => (output as { content: { text: string }[] }).content[0]!.text;
const SCRIPT = 'import pandas as pd\n\nprint("UNIQUE-SCRIPT-BODY-91c2")\n';

describe('write_script and write_test', () => {
  it('stores a script and returns its size, line count, and attempt — never its content', async () => {
    const { results, files } = await runSteps([write('write_script', 'main.py', SCRIPT)]);
    expect(files).toEqual([{ path: 'main.py', role: 'script', content: SCRIPT }]);
    expect(results[0]).toMatchObject({ isError: false });
    expect(details(results[0]!.output)).toEqual({ path: 'main.py', byteSize: Buffer.byteLength(SCRIPT), lineCount: 3, attempt: 1 });
    expect(JSON.stringify(results[0]!.output)).not.toContain('UNIQUE-SCRIPT-BODY');
  });

  it('stores a test file as role test', async () => {
    const { files } = await runSteps([write('write_test', 'test_main.py', 'def test_x():\n    assert True\n')]);
    expect(files).toEqual([{ path: 'test_main.py', role: 'test', content: 'def test_x():\n    assert True\n' }]);
  });

  it.each([
    ['write_test', 'main.py', 'test_<name>.py'],
    ['write_script', 'test_x.py', 'reserved for tests'],
    ['write_script', '../x.py', '`..` is not allowed'],
    ['write_script', 'C:\\x.py', 'forward slashes'],
  ] as const)('%s with %j returns an actionable tool error and stores nothing', async (tool, path, hint) => {
    const { results, files } = await runSteps([write(tool, path, 'x = 1\n')]);
    expect(results[0]!.isError).toBe(true);
    expect(text(results[0]!.output)).toContain(hint);
    expect(files).toEqual([]);
  });

  it('refuses a 300 KiB file naming both sizes and stores nothing', async () => {
    const { results, files, harness } = await runSteps([write('write_script', 'main.py', 'x'.repeat(300 * 1024))]);
    expect(results[0]!.isError).toBe(true);
    expect(text(results[0]!.output)).toMatch(/307,200 bytes; the limit is 262,144 bytes/);
    expect(files).toEqual([]);
    expect(harness.repos.versions.listByExecution(harness.execution.id)).toEqual([]);
  });

  it('keeps one row with the later content when a path is written twice in one attempt', async () => {
    const { files } = await runSteps([write('write_script', 'main.py', 'first\n'), write('write_script', 'main.py', 'second\n'), write('write_script', 'lib/helpers.py', 'X = 1\n')]);
    expect(files.map(({ path, content }) => [path, content])).toEqual([['main.py', 'second\n'], ['lib/helpers.py', 'X = 1\n']]);
  });

  it('rejects a missing path, a missing content, and an extra property at the parameter schema', async () => {
    const { results, files } = await runSteps([
      { call: { tool: 'write_script', args: { content: 'x' } } },
      { call: { tool: 'write_script', args: { path: 'main.py' } } },
      { call: { tool: 'write_script', args: { path: 'main.py', content: 'x', mode: 'append' } } },
    ]);
    expect(results.map(({ isError }) => isError)).toEqual([true, true, true]);
    expect(files).toEqual([]);
  });

  it('elides the content in the transcript: the script text appears nowhere in any persisted event (the central test)', async () => {
    const { harness } = await runSteps([write('write_script', 'main.py', SCRIPT), write('write_test', 'test_main.py', `def test_x():\n    assert "UNIQUE-TEST-BODY-5e1f"\n`)]);
    const started = harness.transcript().filter((event) => event.type === 'tool_started');
    expect(started.map((event) => (event as { input: unknown }).input)).toEqual([
      { path: 'main.py', content: { elided: true, byteSize: Buffer.byteLength(SCRIPT) } },
      { path: 'test_main.py', content: { elided: true, byteSize: expect.any(Number) } },
    ]);
    const payloads = (harness.store.connection.client.prepare('SELECT payload FROM conversation_event').all() as { payload: string }[]).map(({ payload }) => payload).join('\n');
    expect(payloads).not.toContain('UNIQUE-SCRIPT-BODY');
    expect(payloads).not.toContain('UNIQUE-TEST-BODY');
  });

  it('refuses further writes once a final version exists', async () => {
    const { results } = await runSteps([write('write_script', 'main.py', SCRIPT), { call: { tool: 'run_tests', args: {} } }, finalizeStep('x.csv', { declaredInputs: [] }), write('write_script', 'main.py', 'changed\n')]);
    expect(results.at(-1)).toMatchObject({ tool: 'write_script', isError: true });
    expect(text(results.at(-1)!.output)).toContain('already finalized attempt 1');
  });
});
