import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { INTERRUPTION_MESSAGES, type RunRecord } from '@automate/core';
import { RunRecordPanel } from '../../../components/history/run-record-panel';
import { DisclosureReceipt } from '../../../components/disclosure/disclosure-receipt';
import { ClarificationCard } from '../../../components/conversation/clarification-card';
import { CodeVersionCard } from '../../../components/generation/code-version-card';
import { VerificationReport } from '../../../components/verification/verification-report';
import { RunResult } from '../../../components/execution/run-result';
import { ArtifactList } from '../../../components/artifacts/artifact-list';
import { getDisclosureReceipts } from '../../../api/disclosure-queries';
import { getClarifications } from '../../../api/clarification-mutations';
import { getCodeVersion } from '../../../api/generation-queries';
import { getRun, getVerification } from '../../../api/verification-queries';
import { getArtifacts } from '../../../api/artifact-queries';
import { ds } from '../../../design-system/tokens';

const mock = vi.hoisted(() => ({ record: null as RunRecord | null, latest: vi.fn(), task: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a href="/run">{children}</a> }));
vi.mock('../../../api/history-queries', () => ({ useRunRecord: () => ({ data: mock.record, isPending: false }), getRunTimeline: mock.latest }));
vi.mock('../../../api/task-queries', () => ({ getTask: mock.task }));
vi.mock('../../../components/history/run-again-button', () => ({ RunAgainButton: () => <button>Run again</button> }));
vi.mock('../../../components/saved/save-task-dialog', () => ({ SaveTaskDialog: () => null }));
// The owning features' views and endpoints, replaced so each is asserted by identity.
vi.mock('../../../components/disclosure/disclosure-receipt', () => ({ DisclosureReceipt: vi.fn(() => <p>receipt view</p>) }));
vi.mock('../../../components/conversation/clarification-card', () => ({ ClarificationCard: vi.fn(() => <p>clarification view</p>) }));
vi.mock('../../../components/generation/code-version-card', () => ({ CodeVersionCard: vi.fn(() => <p>code view</p>) }));
vi.mock('../../../components/verification/verification-report', () => ({ VerificationReport: vi.fn(() => <p>checks view</p>) }));
vi.mock('../../../components/execution/run-result', () => ({ RunResult: vi.fn(() => <p>run view</p>) }));
vi.mock('../../../components/artifacts/artifact-list', () => ({ ArtifactList: vi.fn(() => <p>outputs view</p>) }));
vi.mock('../../../api/disclosure-queries', () => ({ getDisclosureReceipts: vi.fn(async () => [{ id: 1, kind: 'context', byteSize: 10, provider: 'fake', model: 'm', summary: {}, at: '2026-09-26T10:00:00.000Z' }]) }));
vi.mock('../../../api/clarification-mutations', () => ({ getClarifications: vi.fn(async () => [{ id: 2 }]) }));
vi.mock('../../../api/generation-queries', () => ({ getCodeVersion: vi.fn(async () => ({ id: 4, attempt: 2, contentDigest: 'd'.repeat(64), files: [], sealedAt: null, createdAt: '2026-09-26T10:00:00.000Z' })) }));
vi.mock('../../../api/verification-queries', () => ({ getVerification: vi.fn(async () => ({})), getRun: vi.fn(async () => ({})) }));
vi.mock('../../../api/artifact-queries', () => ({ getArtifacts: vi.fn(async () => ({ artifacts: [] })) }));

const at = '2026-09-26T10:00:00.000Z';
function sparse(): RunRecord {
  return {
    execution: { id: 9, taskId: 3, runNumber: 2, status: 'failed', trigger: 'manual', retryOfExecutionId: null, provider: null, model: null, createdAt: at, startedAt: at, completedAt: at, durationMs: 1, errorCode: 'EXECUTION_INTERRUPTED', errorMessage: INTERRUPTION_MESSAGES.waiting },
    personWords: { guidance: '<script>alert(1)</script> =SUM(A1)', reviewFeedback: null }, chain: { previous: null, next: [] },
    inputs: [], inputsReadByRun: null, disclosure: null, questions: null, code: null, checks: null, approval: null, scriptRun: null, outputs: null,
    transcript: { lastSeq: 0 }, reuse: null, asOf: null,
  };
}
function full(): RunRecord {
  return {
    ...sparse(),
    execution: { ...sparse().execution, status: 'completed', errorCode: null, errorMessage: null, provider: 'fake', model: 'm' },
    personWords: { guidance: null, reviewFeedback: 'Totals were off by one region.' }, chain: { previous: { id: 7, runNumber: 1 }, next: [{ id: 11, runNumber: 3 }] },
    inputs: [{ id: 1, originalFilename: 'sales.csv', format: 'csv', byteSize: 10, sha256: 'a'.repeat(64) }], inputsReadByRun: true,
    disclosure: { provider: 'fake', model: 'm', sendCount: 2, grantedAt: at },
    questions: { total: 3, answered: 3, byPerson: 1, seeded: 2, defaulted: 0, declined: 0 },
    code: { id: 4, attempt: 2, digest: 'd'.repeat(64), shortDigest: 'dddddddddddd', testsPassed: true, attemptCount: 2 },
    checks: { status: 'passed', blockingCount: 0, advisoryCount: 1, summary: 'Passed with 1 warning', runtime: 'Python 3.12.4 on win32 · 8 packages' },
    approval: { decidedAt: at, acknowledgedWarnings: true },
    scriptRun: { status: 'succeeded', exitCode: 0, durationMs: 1200, limitBreach: null, outputTruncated: false, declaredOutputCount: 1, producedOutputCount: 1, artifactCount: 1, unregisteredOutputCount: 0 },
    outputs: { count: 1 }, transcript: { lastSeq: 12 },
  };
}
function mount() { return render(<QueryClientProvider client={new QueryClient()}><RunRecordPanel executionId={9} /></QueryClientProvider>); }
beforeEach(() => {
  vi.clearAllMocks();
  mock.record = sparse(); mock.latest.mockReset(); mock.task.mockReset();
  mock.latest.mockResolvedValue({ items: [{ id: 9 }] });
  mock.task.mockResolvedValue({ task: { id: 3, description: 'Summarize my sales.' } });
});
afterEach(cleanup);

describe('run record', () => {
  it('keeps sparse old runs readable: the interruption leads, only What you asked and Run render, and nothing is styled as an error', async () => {
    const view = mount();
    await waitFor(() => expect(view.container.textContent).toContain('Summarize my sales.'));
    expect(view.container.querySelector('h2')?.nextElementSibling?.textContent).toBe(INTERRUPTION_MESSAGES.waiting);
    expect(view.container.textContent).toContain('<script>alert(1)</script> =SUM(A1)');
    expect(view.container.querySelector('script')).toBeNull();
    expect([...view.container.querySelectorAll('strong')].map((title) => title.textContent)).toEqual(['What you asked', 'Run']);
    expect([...view.container.querySelectorAll('*')].some((element) => element.className === ds.statusDanger)).toBe(false);
    expect(await screen.findByRole('button', { name: 'Run again' })).toBeTruthy();
  });

  it('summarizes every section of a full record in one line each', async () => {
    mock.record = full();
    const view = mount();
    await waitFor(() => expect(view.container.textContent).toContain('Summarize my sales.'));
    const text = view.container.textContent ?? '';
    for (const line of ['You said: Totals were off by one region.', '1 input file · The run read exactly these files', '2 sends to fake (m)', '3 questions · 1 answered by you · 2 carried over from an earlier run', 'Attempt 2 · dddddddddddd · its own tests passed', 'Passed with 1 warning · Python 3.12.4 on win32 · 8 packages', 'you acknowledged the warnings', 'succeeded · 1 second', '1 output', 'Came from run 1', 'Led to run 3']) expect(text).toContain(line);
  });

  it('mounts each owning view lazily on first open, with exactly one request, and none on reopening', async () => {
    mock.record = full();
    const user = userEvent.setup();
    mount();
    await screen.findByText('What was sent');
    const sections = [
      ['What was sent', DisclosureReceipt, getDisclosureReceipts],
      ['Questions', ClarificationCard, getClarifications],
      ['Code', CodeVersionCard, getCodeVersion],
      ['Checks', VerificationReport, getVerification],
      ['Run', RunResult, getRun],
      ['Outputs', ArtifactList, getArtifacts],
    ] as const;
    for (const [, component, endpoint] of sections) { expect(component).not.toHaveBeenCalled(); expect(endpoint).not.toHaveBeenCalled(); }
    for (const [title, component, endpoint] of sections) {
      const summary = screen.getByText(title).closest('summary')!;
      await user.click(summary);
      await waitFor(() => expect(component, title).toHaveBeenCalled());
      expect(vi.mocked(endpoint), title).toHaveBeenCalledTimes(1);
      await user.click(summary); await user.click(summary);
      expect(vi.mocked(endpoint), `${title} reopened`).toHaveBeenCalledTimes(1);
    }
  });

  it('offers Run again only for the latest terminal run', async () => {
    mock.latest.mockResolvedValue({ items: [{ id: 10 }] });
    mount();
    await waitFor(() => expect(mock.latest).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
    cleanup();
    mock.record = { ...sparse(), execution: { ...sparse().execution, status: 'generating', errorCode: null, errorMessage: null } };
    mock.latest.mockResolvedValue({ items: [{ id: 9 }] });
    mount();
    await waitFor(() => expect(mock.latest).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });
});
