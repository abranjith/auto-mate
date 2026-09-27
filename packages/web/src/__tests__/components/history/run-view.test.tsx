// TASK-009: run-view.tsx is the task page's single-run body moved, not rewritten.
// Each owning feature's leaf component is replaced by a vi.fn stub, so the
// assertions are by component identity: that exact export was mounted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationEvent, ExecutionStatus, ExecutionSummary } from '@automate/core';
import { RunView } from '../../../components/history/run-view';
import { RunIntentPanel } from '../../../components/verification/run-intent-panel';
import { ReviewPanel } from '../../../components/review/review-panel';
import { ArtifactList } from '../../../components/artifacts/artifact-list';
import { ClarificationCard } from '../../../components/conversation/clarification-card';
import { artifact, list, run } from '../artifacts/artifact-fixtures';

const mock = vi.hoisted(() => ({ stream: null as unknown }));
vi.mock('../../../api/use-execution-stream', () => ({ useExecutionStream: () => mock.stream }));
vi.mock('../../../components/history/run-record-panel', () => ({ RunRecordPanel: () => null }));
vi.mock('../../../components/generation/generation-section', () => ({ GenerationSection: () => null }));
vi.mock('../../../components/verification/verification-report', () => ({ VerificationReport: () => null }));
vi.mock('../../../components/verification/run-intent-panel', () => ({ RunIntentPanel: vi.fn(() => <div>intent gate</div>) }));
vi.mock('../../../components/review/review-panel', () => ({ ReviewPanel: vi.fn(() => <div>review panel</div>) }));
vi.mock('../../../components/artifacts/artifact-list', () => ({ ArtifactList: vi.fn(() => <div>artifact list</div>) }));
vi.mock('../../../components/conversation/clarification-card', () => ({ ClarificationCard: vi.fn(() => <div>clarification card</div>) }));
vi.mock('../../../api/verification-queries', () => ({
  getVerification: vi.fn(async () => ({})), getIntent: vi.fn(async () => ({ intentDigest: 'i'.repeat(64) })),
  getRun: vi.fn(async () => run()), decideApproval: vi.fn(), submitReview: vi.fn(),
}));
vi.mock('../../../api/artifact-queries', () => ({ getArtifacts: vi.fn(async () => list([artifact()])) }));
vi.mock('../../../api/clarification-mutations', () => ({ getClarifications: vi.fn(async () => [{ id: 5 }]) }));
vi.mock('../../../api/generation-queries', () => ({ retryExecution: vi.fn() }));

const at = '2026-09-26T10:00:00.000Z';
const summary = (status: ExecutionStatus): ExecutionSummary => ({ id: 9, taskId: 3, status, trigger: 'manual', retryOfExecutionId: null, provider: null, model: null, usage: {}, startedAt: at, completedAt: null, durationMs: null, error: null, createdAt: at });
const verified: ConversationEvent = { seq: 2, type: 'verification_finished', verificationRunId: 1, codeVersionId: 1, status: 'passed', blockingCount: 0, advisoryCount: 0, summary: 'All checks passed', runtimeDescription: 'Python 3.12', at };
const ran: ConversationEvent = { seq: 3, type: 'run_finished', scriptRunId: 1, status: 'succeeded', exitCode: 0, durationMs: 5, declaredOutputCount: 1, producedOutputCount: 1, outputTruncated: false, at };
const registered: ConversationEvent = { seq: 4, type: 'artifacts_registered', scriptRunId: 1, artifactCount: 1, undeclaredCount: 0, unregisteredOutputCount: 0, totalBytes: 10, at };
const asked: ConversationEvent = { seq: 2, type: 'clarification_requested', clarificationId: 5, at };
const prompt: ConversationEvent = { seq: 1, type: 'user_prompt', text: 'Total it', at };

function mount(status: ExecutionStatus, events: ConversationEvent[]) {
  mock.stream = { execution: summary(status), events: [prompt, ...events], connection: 'closed', retry: vi.fn() };
  return render(<QueryClientProvider client={new QueryClient()}><RunView taskId="3" executionId={9} /></QueryClientProvider>);
}
beforeEach(() => { for (const component of [RunIntentPanel, ReviewPanel, ArtifactList, ClarificationCard]) vi.mocked(component).mockClear(); });
afterEach(cleanup);

describe('RunView extraction', () => {
  it('mounts FEAT-107\'s intent gate for a run at awaiting_approval', async () => {
    mount('awaiting_approval', [verified]);
    await waitFor(() => expect(RunIntentPanel).toHaveBeenCalled());
    expect(ReviewPanel).not.toHaveBeenCalled();
  });

  it('mounts FEAT-107\'s review panel for a run at awaiting_review', async () => {
    mount('awaiting_review', [verified, ran, registered]);
    await waitFor(() => expect(ReviewPanel).toHaveBeenCalled());
    expect(RunIntentPanel).not.toHaveBeenCalled();
  });

  it('mounts FEAT-109\'s artifact list for a completed run with artifacts', async () => {
    mount('completed', [verified, ran, registered]);
    await waitFor(() => expect(ArtifactList).toHaveBeenCalled());
  });

  it('mounts FEAT-105\'s clarification card for a waiting run', async () => {
    mount('waiting', [asked]);
    await waitFor(() => expect(ClarificationCard).toHaveBeenCalled());
  });
});
