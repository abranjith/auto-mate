import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutoMateError, MAX_GUIDANCE_CHARS, type CodeVersionDetail, type ConversationEvent, type ExecutionSummary, type GenerationAttempt, type SyntheticFixture } from '@automate/core';
import { CodeVersionCard } from '../../../components/generation/code-version-card';
import { CodeFileView } from '../../../components/generation/code-file-view';
import { TestRunResult, withheldSentence } from '../../../components/generation/test-run-result';
import { FixtureNote, fixtureSentence } from '../../../components/generation/fixture-note';
import { GenerationProgress, generationPhase, waitingMs } from '../../../components/generation/generation-progress';
import { GenerationFailurePanel } from '../../../components/generation/generation-failure-panel';
import { TestRunEvent } from '../../../components/generation/test-run-event';

afterEach(cleanup);
const at = '2026-09-24T00:00:00.000Z';
const digest = 'ab12cd34ef56'.padEnd(64, '0');
type Sealed = Extract<ConversationEvent, { type: 'code_version_sealed' }>;
type TestRun = Extract<ConversationEvent, { type: 'test_run_finished' }>;
const sealed: Sealed = { seq: 3, type: 'code_version_sealed', codeVersionId: 7, attempt: 1, digest, files: [{ path: 'main.py', role: 'script', byteSize: 60, lineCount: 3 }, { path: 'test_main.py', role: 'test', byteSize: 30, lineCount: 2 }], at };
const failedRun: TestRun = { seq: 4, type: 'test_run_finished', attemptId: 1, attempt: 1, outcome: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, droppedLineCount: 14, attemptsRemaining: 2, attemptLimit: 3, manifestPresent: false, at };
const HOSTILE_CODE = 'print("<script>alert(1)</script>")\nx = 1\ny = 2\n';
const detail: CodeVersionDetail = { id: 7, executionId: 2, attempt: 1, status: 'tested_fail', contentDigest: digest, entrypoint: 'main.py', isFinal: false, testsPassed: false, summary: null, sealedAt: at, createdAt: at, declaredInputs: null, declaredOutputs: null, files: [{ path: 'main.py', role: 'script', byteSize: 60, lineCount: 3, sha256: digest, content: HOSTILE_CODE }] };
const fixture: SyntheticFixture = { id: 1, executionId: 2, uploadId: 3, fileName: '3-sales.csv', format: 'csv', sheetCount: 1, rowCount: 200, sampleRowCount: 10, byteSize: 4096, sha256: digest, seed: 'seed', createdAt: at, preview: [{ sheetName: null, header: ['region', 'note'], rows: [['North', '=HYPERLINK("http://x")'], ['<img src=x onerror=alert(1)>', '@SUM(A1)']] }] };
const execution: ExecutionSummary = { id: 2, taskId: 1, status: 'failed', provider: 'fake', model: 'fake', usage: {}, startedAt: at, completedAt: at, durationMs: 10, error: { code: 'GENERATION_ATTEMPTS_EXHAUSTED', message: 'This run used all 3 attempts.' }, createdAt: at };
const attempt = (n: number, overrides: Partial<GenerationAttempt> = {}): GenerationAttempt => ({ id: n, executionId: 2, codeVersionId: n, attempt: n, status: 'failed', refusalReason: null, testsTotal: 3, testsPassed: 2, testsFailed: 1, exitCode: 1, manifestPresent: false, diagnosticDigest: null, droppedLineCount: 0, durationMs: 5, startedAt: at, settledAt: at, diagnostics: null, ...overrides });

describe('GenerationProgress', () => {
  it('shows the attempt number and the cap, the phase, and the elapsed share of the time budget', () => {
    render(<GenerationProgress events={[sealed]} limits={{ maxAttempts: 3, timeoutMs: 600_000 }} startedAt={at} now={Date.parse(at) + 240_000} />);
    expect(screen.getByText('Attempt 1 of 3')).toBeTruthy();
    expect(screen.getByText(/running its tests/)).toBeTruthy();
    expect(screen.getByText('4 min of 10 min')).toBeTruthy();
    expect((screen.getByLabelText('Time used') as HTMLProgressElement).value).toBe(240_000);
  });

  it('leaves time spent waiting for an answer out of the elapsed share, as the server does', () => {
    const start = Date.parse(at);
    const waiting: ConversationEvent[] = [
      { seq: 1, type: 'state_changed', from: 'generating', to: 'waiting', at: new Date(start + 60_000).toISOString() },
      { seq: 2, type: 'state_changed', from: 'waiting', to: 'generating', at: new Date(start + 360_000).toISOString() },
    ];
    expect(waitingMs(waiting, start + 400_000)).toBe(300_000);
    expect(waitingMs(waiting.slice(0, 1), start + 400_000)).toBe(340_000);
    render(<GenerationProgress events={waiting} limits={{ maxAttempts: 3, timeoutMs: 600_000 }} startedAt={at} now={start + 420_000} />);
    expect(screen.getByText('2 min of 10 min')).toBeTruthy();
  });

  it('moves to the next attempt after a failure and says when the loop is done', () => {
    expect(generationPhase([sealed, failedRun])).toEqual({ attempt: 2, phase: 'repairing the script' });
    expect(generationPhase([])).toEqual({ attempt: 1, phase: 'writing the script' });
    expect(generationPhase([{ ...failedRun, outcome: 'passed' }]).phase).toContain('final version');
    expect(generationPhase([sealed, { seq: 9, type: 'generation_settled', outcome: 'finalized', codeVersionId: 7, digest, attemptsUsed: 1, attemptLimit: 3, summary: 'Done.', at }]).phase).toBe('finished');
  });
});

describe('CodeVersionCard', () => {
  it('lists files and line counts collapsed, and expands to content matching the API character for character, as text', async () => {
    const user = userEvent.setup();
    const load = vi.fn().mockResolvedValue(detail);
    const { container } = render(<CodeVersionCard event={sealed} load={load} />);
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByText(/Attempt 1 — 2 files, 5 lines/)).toBeTruthy();
    expect(screen.getByText('ab12cd34ef56')).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    await user.click(screen.getByText(/Attempt 1 — 2 files/));
    await waitFor(() => expect(load).toHaveBeenCalledWith(7));
    const pre = await screen.findByLabelText('Contents of main.py');
    expect(pre.textContent).toBe('1print("<script>alert(1)</script>")2x = 13y = 2');
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('tests failed')).toBeTruthy();
  });

  it('copies a file\'s exact content', async () => {
    const user = userEvent.setup();
    const copy = vi.fn().mockResolvedValue(undefined);
    render(<CodeFileView file={detail.files[0]!} copy={copy} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(copy).toHaveBeenCalledWith(HOSTILE_CODE);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });
});

describe('TestRunResult', () => {
  it('renders the counts, the filtered text as literal text, and the withheld-line sentence', () => {
    const { container } = render(<TestRunResult event={failedRun} diagnostics={'KeyError: <str len=6>\njavascript:alert(1)'} />);
    expect(screen.getByText('Attempt 1: 1 of 3 tests failed.')).toBeTruthy();
    expect(screen.getByText('2 of 3 attempts left.')).toBeTruthy();
    expect(container.querySelector('pre')!.textContent).toBe('KeyError: <str len=6>\njavascript:alert(1)');
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('14 lines of output were not recognized as safe to send, so they were dropped.')).toBeTruthy();
  });

  it('omits the withheld sentence entirely when nothing was dropped, rather than saying "0 lines"', () => {
    const { container } = render(<TestRunResult event={{ ...failedRun, droppedLineCount: 0 }} />);
    expect(container.textContent).not.toMatch(/dropped|0 lines/);
    expect(withheldSentence(null)).toBeNull();
    expect(withheldSentence(1)).toBe('1 line of output was not recognized as safe to send, so it was dropped.');
  });

  it('explains a refusal in plain English', () => {
    render(<TestRunResult event={{ ...failedRun, attempt: 4, outcome: 'refused', refusalReason: 'attempt_limit', testsTotal: null, testsPassed: null, testsFailed: null, droppedLineCount: null, attemptsRemaining: 0 }} />);
    expect(screen.getByText('Attempt 4 was not run because every allowed attempt had already been used.')).toBeTruthy();
  });
});

describe('FixtureNote', () => {
  it('states the synthetic row count, the approved sample rows, and that the real file was not read', () => {
    render(<FixtureNote fixtures={[fixture]} />);
    const sentence = 'Tested against 200 synthetic rows built from your column descriptions and the 10 sample rows you approved. Your real file has not been read yet.';
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(fixtureSentence(null, null)).toContain('Your real file has not been read yet.');
  });

  it('renders preview cells literally: formulas, markup, and @-prefixes stay text', async () => {
    const user = userEvent.setup();
    const { container } = render(<FixtureNote fixtures={[fixture]} />);
    await user.click(screen.getByText('Show the test data'));
    expect(screen.getByText('=HYPERLINK("http://x")')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('@SUM(A1)')).toBeTruthy();
    expect(container.querySelector('img, a')).toBeNull();
  });

  it('renders on every attempt through the transcript entry', async () => {
    const loadAttempts = vi.fn().mockResolvedValue({ attempts: [attempt(1, { diagnostics: 'ValueError: <str len=3>' })], limits: { maxAttempts: 3, timeoutMs: 600_000 } });
    const loadFixtures = vi.fn().mockResolvedValue([fixture]);
    render(<>{[failedRun, { ...failedRun, seq: 8, attemptId: 2, attempt: 2, outcome: 'passed' as const }].map((event) => <TestRunEvent key={event.seq} event={event} executionId={2} loadAttempts={loadAttempts} loadFixtures={loadFixtures} />)}</>);
    await waitFor(() => expect(screen.getAllByText(/Your real file has not been read yet\./)).toHaveLength(2));
    expect(await screen.findByText('ValueError: <str len=3>')).toBeTruthy();
    expect(loadAttempts).toHaveBeenCalledTimes(1);
  });
});

describe('GenerationFailurePanel', () => {
  const attempts = [attempt(1), attempt(2, { status: 'errored' }), attempt(3)];

  it('lists every attempt with its outcome and the summary', () => {
    render(<GenerationFailurePanel execution={execution} attempts={attempts} summary="Used all 3 attempts without getting the tests to pass." renderLink={false} />);
    expect(screen.getByText('Tell me what I got wrong and I\'ll try again.')).toBeTruthy();
    expect(screen.getByText('Used all 3 attempts without getting the tests to pass.')).toBeTruthy();
    expect(screen.getByText('Attempt 1: 1 of 3 tests failed.')).toBeTruthy();
    expect(screen.getByText(/Attempt 2: the tests could not start/)).toBeTruthy();
  });

  it('disables retry while the guidance exceeds the cap, then posts it exactly once', async () => {
    const user = userEvent.setup();
    let release!: (value: never) => void;
    const onRetry = vi.fn(() => new Promise<never>((resolve) => { release = resolve; }));
    const onRetried = vi.fn();
    render(<GenerationFailurePanel execution={execution} attempts={attempts} onRetry={onRetry} onRetried={onRetried} renderLink={false} />);
    const box = screen.getByRole('textbox');
    await user.click(box);
    await user.paste('x'.repeat(MAX_GUIDANCE_CHARS + 1));
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(box);
    await user.type(box, 'Group by month.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Starting…' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(2, 'Group by month.');
    release({ task: {}, execution: { id: 9 } } as never);
    await waitFor(() => expect(onRetried).toHaveBeenCalledTimes(1));
  });

  it('surfaces the server\'s message, and for a stale approval offers to review what is sent instead of retrying blindly', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn().mockRejectedValue(new AutoMateError('DISCLOSURE_CONSENT_STALE', 'The recipient changed from fake a to fake b since you approved this.'));
    render(<GenerationFailurePanel execution={execution} attempts={attempts} onRetry={onRetry} renderLink={false} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/The recipient changed/)).toBeTruthy();
    expect(screen.getByText(/Review what is sent and approve it again/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets a person leave the run as it is', async () => {
    const user = userEvent.setup();
    render(<GenerationFailurePanel execution={execution} attempts={attempts} renderLink={false} />);
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/stays as it is/)).toBeTruthy();
  });
});
