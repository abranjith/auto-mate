import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AutoMateError, CHECK_KEYS, ERROR_CODES, RUN_INTENT_CAVEATS, type ApprovalResponse, type ConversationEvent, type ExecutionSummary, type RunIntentResponse, type ScriptRun, type VerificationReport as Report } from '@automate/core';
import { VerificationReport } from '../../../components/verification/verification-report';
import { RunIntentPanel } from '../../../components/verification/run-intent-panel';
import { RunResult, OUTPUTS_ARRIVE_LATER } from '../../../components/execution/run-result';
import { ReviewPanel } from '../../../components/review/review-panel';
import { ConversationView } from '../../../components/conversation/conversation-view';
import { GateSection, type GateApi } from '../../../components/verification/gate-section';

afterEach(cleanup);
const at = '2026-09-25T00:00:00.000Z';
const D = 'a'.repeat(64);
const wrap = (node: ReactNode) => <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;

function report(overrides: Partial<Report> = {}, message = 'Undefined name `x`'): Report {
  return {
    id: 1, executionId: 2, codeVersionId: 3, contentDigest: D, runtimeFingerprint: D,
    runtime: { pythonVersion: '3.12.4', uvVersion: 'uv', platform: 'linux', arch: 'x64', packages: [] }, runtimeDescription: 'Python 3.12.4 on Linux (x64)',
    status: 'passed', blockingCount: 0, advisoryCount: 1, summary: 'No blocking problems found; 1 advisory finding to review.', durationMs: 10, startedAt: at, settledAt: at,
    // Deliberately out of order: the report must render in policy order.
    checks: [...CHECK_KEYS].reverse().map((checkKey) => ({ checkKey, status: 'passed' as const, isBlocking: checkKey === 'tests', summary: `${checkKey} ok`, detail: null, durationMs: 1 })),
    findings: [{ id: 1, checkKey: 'lint', ruleCode: 'F401', severity: 'low', confidence: null, filePath: 'main.py', line: 1, column: 1, message, isBlocking: false }],
    ...overrides,
  };
}
function intent(overrides: Partial<RunIntentResponse['intent']> = {}): RunIntentResponse {
  return {
    intentDigest: D,
    intent: { executionId: 2, codeVersion: { id: 3, shortDigest: 'aaaaaaaaaaaa', contentDigest: D, fileCount: 2, lineCount: 20, entrypoint: 'main.py' }, verificationRunId: 1, summary: 'Totals sales by region.', inputs: [{ uploadId: 1, originalFilename: 'sales.csv', byteSize: 2048, shortSha256: 'cccccccccccc', sheets: [] }], outputs: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Per region.' }], checks: [], verdict: 'All checks passed.', blockingCount: 0, advisoryCount: 0, tests: { total: 3, passed: 3, fixtureRowCount: 200 }, runtime: { fingerprint: D, description: 'Python 3.12.4 on Linux (x64)', packages: [] }, caveats: [...RUN_INTENT_CAVEATS], ...overrides },
  };
}
function run(overrides: Partial<ScriptRun> = {}): ScriptRun {
  return { id: 1, executionId: 2, codeVersionId: 3, approvalId: 4, contentDigest: D, runtimeFingerprint: D, status: 'succeeded', exitCode: 0, stdout: 'done', stderr: '', outputTruncated: false, manifestPresent: true, declaredOutputs: [{ filename: 'totals.csv', type: 'csv', title: 'Totals', description: 'Per region.', byteSize: 2048, present: true }], declaredOutputCount: 1, producedOutputCount: 1, outputByteCount: 2048, limitBreached: null, runtimeLockDigest: D, inputs: [], durationMs: 10, startedAt: at, settledAt: at, ...overrides };
}
const approved: ApprovalResponse = { outcome: 'approved', approvalId: 1, runtimeChanges: [], status: 'executing' };

describe('VerificationReport', () => {
  it('renders seven checks in policy order with badges matching is_blocking', () => {
    const { container } = render(<VerificationReport report={report()} />);
    const rows = [...container.querySelectorAll('[data-check]')];
    expect(rows.map((row) => row.getAttribute('data-check'))).toEqual([...CHECK_KEYS]);
    for (const row of rows) expect(within(row as HTMLElement).getByText(row.getAttribute('data-check') === 'tests' ? 'Blocking' : 'Advisory')).toBeTruthy();
    expect(screen.getByText(/Checked against Python 3.12.4 on Linux \(x64\)/)).toBeTruthy();
  });
  it('reads as a sentence when blocked and offers no way to run', () => {
    render(<VerificationReport report={report({ status: 'failed', blockingCount: 2, summary: "This code can't run yet: 1 high-severity security finding and 1 failing test." })} />);
    expect(screen.getByText("This code can't run yet: 1 high-severity security finding and 1 failing test.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
  });
});

describe('RunIntentPanel', () => {
  it('renders all three caveats verbatim from the constant', () => {
    render(<RunIntentPanel data={intent()} onDecide={vi.fn()} onStale={vi.fn()} />);
    for (const caveat of RUN_INTENT_CAVEATS) expect(screen.getByText(caveat).textContent).toBe(caveat);
    expect(screen.getAllByRole('listitem').filter((item) => RUN_INTENT_CAVEATS.includes(item.textContent as never))).toHaveLength(3);
  });
  it('keeps Run it disabled until advisory findings are acknowledged, then sends the decision', async () => {
    const onDecide = vi.fn(() => Promise.resolve(approved));
    render(<RunIntentPanel data={intent({ advisoryCount: 2 })} onDecide={onDecide} onStale={vi.fn()} />);
    const run = screen.getByRole('button', { name: 'Run it' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(run.disabled).toBe(false);
    await userEvent.click(run);
    expect(onDecide).toHaveBeenCalledWith('approved', true);
  });
  it('refetches on a stale page and returns the button to disabled', async () => {
    const onStale = vi.fn();
    const onDecide = vi.fn(() => Promise.reject(new AutoMateError(ERROR_CODES.APPROVAL_INTENT_MISMATCH, 'This page is out of date.')));
    render(<RunIntentPanel data={intent({ advisoryCount: 1 })} onDecide={onDecide} onStale={onStale} />);
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Run it' }));
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert').textContent).toBe('This page is out of date.');
    expect((screen.getByRole('button', { name: 'Run it' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows the concrete runtime changes when the run goes back to checking', async () => {
    render(<RunIntentPanel data={intent()} onDecide={() => Promise.resolve({ outcome: 'reverify', approvalId: null, runtimeChanges: ['Python changed from 3.12.4 to 3.13.1'], status: 'verifying' })} onStale={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run it' }));
    expect(await screen.findByText('Python changed from 3.12.4 to 3.13.1.')).toBeTruthy();
  });
  it('cancels', async () => {
    const onDecide = vi.fn(() => Promise.resolve({ ...approved, outcome: 'cancelled' as const }));
    render(<RunIntentPanel data={intent()} onDecide={onDecide} onStale={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDecide).toHaveBeenCalledWith('cancelled', false);
  });
});

describe('RunResult', () => {
  it('shows the outcome in words, outputs with type and size, the honest absence, and the truncation notice', () => {
    render(<RunResult run={run({ outputTruncated: true })} />);
    expect(screen.getByText('The script finished and produced everything it said it would.')).toBeTruthy();
    expect(screen.getByText(/totals\.csv \(csv, 2 KB\)/)).toBeTruthy();
    expect(screen.getByText(OUTPUTS_ARRIVE_LATER)).toBeTruthy();
    expect(screen.getByText(/only its beginning and end were kept/)).toBeTruthy();
  });
  it('names the exit code of a failed run', () => {
    render(<RunResult run={run({ status: 'failed', exitCode: 2 })} />);
    expect(screen.getByText('The script stopped with an error (exit code 2).')).toBeTruthy();
  });
});

describe('ReviewPanel', () => {
  it('rejects empty feedback client-side and shows the character limit', async () => {
    const onReview = vi.fn();
    render(<ReviewPanel onReview={onReview} />);
    await userEvent.click(screen.getByRole('button', { name: "No — here's what's wrong" }));
    expect(screen.getByText('0 / 2,000')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again with this' }));
    expect(onReview).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Say what was wrong/);
  });
  it('accepts, and hands a rejection\'s retry id forward', async () => {
    const onReview = vi.fn((verdict: 'accepted' | 'rejected') => Promise.resolve(verdict === 'accepted' ? { status: 'completed', retryExecutionId: null } : { status: 'rejected', retryExecutionId: 9 }));
    const onRetried = vi.fn();
    render(<ReviewPanel onReview={onReview} onRetried={onRetried} />);
    await userEvent.click(screen.getByRole('button', { name: "No — here's what's wrong" }));
    await userEvent.type(screen.getByRole('textbox'), 'Exclude refunds');
    await userEvent.click(screen.getByRole('button', { name: 'Try again with this' }));
    await waitFor(() => expect(onRetried).toHaveBeenCalledWith(9));
    expect(onReview).toHaveBeenCalledWith('rejected', 'Exclude refunds');
  });
});

describe('untrusted content renders as literal text on every surface', () => {
  const PAYLOADS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '=HYPERLINK("http://x")', '+cmd|calc', '-2+3', '@SUM(A1)'];
  function surfaces(payload: string): [string, ReactNode][] {
    const events: ConversationEvent[] = [{ seq: 1, type: 'verification_finished', verificationRunId: 1, codeVersionId: 3, status: 'passed', blockingCount: 0, advisoryCount: 0, summary: payload, runtimeDescription: 'Python 3.12.4 on Linux (x64)', at }];
    return [
      ['the report', <VerificationReport report={report({}, payload)} />],
      ['the intent panel', <RunIntentPanel data={intent({ summary: payload, outputs: [{ filename: 'a.csv', type: 'csv', title: payload, description: payload }] })} onDecide={vi.fn()} onStale={vi.fn()} />],
      ['the run result', <RunResult run={run({ stdout: payload, declaredOutputs: [{ filename: 'a.csv', type: 'csv', title: payload, description: payload, byteSize: 1, present: true }] })} />],
      ['the transcript', <ConversationView events={events} />],
    ];
  }
  for (const payload of PAYLOADS) {
    it.each(surfaces(payload).map(([name, node]) => [name, node] as const))(`renders ${JSON.stringify(payload)} literally in %s`, async (_name, node) => {
      const { container } = render(node);
      for (const details of container.querySelectorAll('details')) details.open = true;
      expect(container.textContent).toContain(payload);
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      for (const anchor of container.querySelectorAll('a')) expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
      expect(container.querySelector('[onerror]')).toBeNull();
    });
  }
});

describe('GateSection', () => {
  const api = (overrides: Partial<GateApi> = {}): GateApi => ({ getVerification: vi.fn(() => Promise.resolve(report())), getIntent: vi.fn(() => Promise.resolve(intent())), getRun: vi.fn(() => Promise.resolve(run())), decideApproval: vi.fn(() => Promise.resolve(approved)), submitReview: vi.fn(() => Promise.resolve({ status: 'completed', retryExecutionId: null })), ...overrides });
  const finished: ConversationEvent = { seq: 5, type: 'verification_finished', verificationRunId: 1, codeVersionId: 3, status: 'passed', blockingCount: 0, advisoryCount: 0, summary: 'All checks passed.', runtimeDescription: 'Python 3.12.4 on Linux (x64)', at };
  const base: ExecutionSummary = { id: 2, taskId: 1, status: 'verifying', provider: null, model: null, usage: {}, startedAt: at, completedAt: null, durationMs: null, error: null, createdAt: at };
  it('says it is checking while verifying', () => {
    render(wrap(<GateSection execution={base} events={[]} api={api()} />));
    expect(screen.getByText('Checking the code…')).toBeTruthy();
  });
  it('shows the report and the gate at awaiting_approval, and sends the displayed digest', async () => {
    const gate = api();
    render(wrap(<GateSection execution={{ ...base, status: 'awaiting_approval' }} events={[finished]} api={gate} />));
    await userEvent.click(await screen.findByRole('button', { name: 'Run it' }));
    expect(gate.decideApproval).toHaveBeenCalledWith(2, { intentDigest: D, decision: 'approved', acknowledgedWarnings: false });
    expect(screen.getByLabelText('Code check results')).toBeTruthy();
  });
  it('shows progress with the honest access line while executing, and no gate', () => {
    render(wrap(<GateSection execution={{ ...base, status: 'executing' }} events={[finished]} api={api()} now={Date.parse(at) + 65_000} />));
    expect(screen.getByText(/1 minute 5 seconds so far/)).toBeTruthy();
    expect(screen.getByText('This is running on your computer with the same access this application has.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run it' })).toBeNull();
  });
  it('shows the result and the review question at awaiting_review', async () => {
    const events: ConversationEvent[] = [finished, { seq: 9, type: 'run_finished', scriptRunId: 1, status: 'succeeded', exitCode: 0, durationMs: 5, declaredOutputCount: 1, producedOutputCount: 1, outputTruncated: false, at }];
    render(wrap(<GateSection execution={{ ...base, status: 'awaiting_review' }} events={events} api={api()} />));
    expect(await screen.findByText('Did this do what you wanted?')).toBeTruthy();
    expect(await screen.findByLabelText('Run result')).toBeTruthy();
  });
});
