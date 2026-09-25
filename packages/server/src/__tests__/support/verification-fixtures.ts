// Shared test support for the FEAT-107 suites: a finalized FEAT-106 generation
// (real rows, scripted agent, scripted runner) to verify. Not a test file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FakeAgentStep } from '../../agent/testing/fake-agent-provider';
import { createGenerationHarness, finalizeStep, writeSteps, type HarnessOptions } from './generation-harness';
import { writeStreamingWorkbook } from './workbook-fixtures';

export const RUN_TESTS: FakeAgentStep = { call: { tool: 'run_tests', args: {} } };

/** Steps that write, test once, and finalize; `finalize` overrides the declared contract. */
export function finalizedSteps(input: string, finalize: Record<string, unknown> = {}, script?: string): FakeAgentStep[] {
  return [...writeSteps(input, script), RUN_TESTS, finalizeStep(input, finalize)];
}

/**
 * Create and run a harness whose agent finalizes one version.
 * @returns The harness with the run settled.
 */
export async function createFinalizedHarness(options: HarnessOptions & { readonly finalize?: Record<string, unknown>; readonly script?: string } = {}) {
  const h = await createGenerationHarness({ pythonRuns: [{}], ...options, steps: options.steps ?? ((upload) => finalizedSteps(upload?.storedFilename ?? 'none.csv', options.finalize, options.script)) });
  await h.run();
  const final = h.repos.versions.findFinal(h.execution.id);
  return { ...h, final: final ? h.repos.versions.getByIdWithFiles(final.id)! : null };
}

/** Bytes of a small two-sheet workbook with typed cells. */
export async function workbookBytes(): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'automate-wb-'));
  try {
    const file = path.join(dir, 'book.xlsx');
    // Text and numbers only: a native date column cannot be profiled yet (FEAT-104 defect, see TODO.md).
    const rows = Array.from({ length: 30 }, (_, index) => [index % 2 ? 'north' : 'south', index * 1.5]);
    await writeStreamingWorkbook(file, [{ name: 'Sales', rows: [['region', 'amount'], ...rows] }, { name: 'Notes', rows: [['note'], ['a'], ['b']] }]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
