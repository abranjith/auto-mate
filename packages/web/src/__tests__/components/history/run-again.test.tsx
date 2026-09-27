import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AutoMateError, ERROR_CODES } from '@automate/core';
import { RunAgainButton } from '../../../components/history/run-again-button';

const mock = vi.hoisted(() => ({
  retry: vi.fn(), preview: vi.fn(), grant: vi.fn(), task: vi.fn(), navigate: vi.fn(), replay: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mock.navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="/task/run">{children}</a>,
}));
vi.mock('../../../api/generation-queries', () => ({ retryExecution: mock.retry }));
vi.mock('../../../api/disclosure-queries', () => ({ getDisclosurePreview: mock.preview, grantDisclosureConsent: mock.grant }));
vi.mock('../../../api/task-queries', () => ({ getTask: mock.task }));
vi.mock('../../../api/template-queries', () => ({ replayExecution: mock.replay }));
vi.mock('../../../components/disclosure/disclosure-review-panel', () => ({
  DisclosureReviewPanel: ({ onApprove }: { onApprove: (value: { diagnostics: boolean; decisions: { findingKey: string; choice: string }[] }) => void }) => <section aria-label="Disclosure review"><button onClick={() => onApprove({ diagnostics: true, decisions: [{ findingKey: 'x', choice: 'keep' }] })}>Approve reviewed data</button></section>,
}));

function mount() {
  return render(<QueryClientProvider client={new QueryClient()}><RunAgainButton taskId={3} executionId={9} uploadIds={[7]} /></QueryClientProvider>);
}
beforeEach(() => {
  Object.values(mock).forEach((fn) => fn.mockReset());
  mock.navigate.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Run again', () => {
  it('reopens the disclosure review, attaches new consent to the task, then retries with reviewed decisions', async () => {
    const user = userEvent.setup();
    mock.retry.mockRejectedValueOnce(new AutoMateError(ERROR_CODES.DISCLOSURE_CONSENT_STALE, 'Recipient changed.'));
    mock.retry.mockResolvedValueOnce({ execution: { id: 10 } });
    mock.preview.mockResolvedValue({ uploadIds: [7], digest: 'a'.repeat(64), text: 'Rows: one', byteSize: 9, provider: 'fake', model: 'new', truncations: [], required: [], defaults: [], notices: [] });
    mock.grant.mockResolvedValue({ id: 11 });
    mount();
    await user.click(screen.getByRole('button', { name: 'Run again' }));
    expect(await screen.findByRole('region', { name: 'Disclosure review' })).toBeTruthy();
    expect(mock.preview).toHaveBeenCalledWith([7]);
    await user.click(screen.getByRole('button', { name: 'Approve reviewed data' }));
    await waitFor(() => expect(mock.retry).toHaveBeenCalledTimes(2));
    expect(mock.grant).toHaveBeenCalledWith({ taskId: 3, uploadIds: [7], payloadDigest: 'a'.repeat(64), scopeDiagnostics: true });
    expect(mock.retry).toHaveBeenLastCalledWith(9, '', [{ findingKey: 'x', choice: 'keep' }]);
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledWith({ to: '/tasks/$taskId/runs/$executionId', params: { taskId: '3', executionId: '10' } }));
  });

  it('posts the guidance once, even on a double click, and opens the new run', async () => {
    const user = userEvent.setup();
    let resolve!: (value: { execution: { id: number } }) => void;
    mock.retry.mockReturnValue(new Promise((done) => { resolve = done; }));
    mount();
    await user.type(screen.getByRole('textbox'), 'Use the net amount');
    await user.dblClick(screen.getByRole('button', { name: 'Run again' }));
    resolve({ execution: { id: 10 } });
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledWith({ to: '/tasks/$taskId/runs/$executionId', params: { taskId: '3', executionId: '10' } }));
    expect(mock.retry).toHaveBeenCalledTimes(1);
    expect(mock.retry).toHaveBeenCalledWith(9, 'Use the net amount', undefined);
  });

  it('links to the persisted open run when retry is refused', async () => {
    const user = userEvent.setup();
    mock.retry.mockRejectedValue(new AutoMateError(ERROR_CODES.TASK_HAS_OPEN_RUN, 'Finish or cancel run 12 first.'));
    mock.task.mockResolvedValue({ counts: { openRunId: 12 } });
    mount();
    await user.click(screen.getByRole('button', { name: 'Run again' }));
    expect(await screen.findByRole('link', { name: 'Open that run' })).toBeTruthy();
    expect(mock.retry).toHaveBeenCalledTimes(1);
    expect(mock.task).toHaveBeenCalledWith(3);
  });
});

describe('Run again for a saved-task run (FEAT-111)', () => {
  const mountSaved = (savedCode: boolean) => render(<QueryClientProvider client={new QueryClient()}><RunAgainButton taskId={3} executionId={9} uploadIds={[7]} savedCode={savedCode} /></QueryClientProvider>);
  it('offers Run again exactly and Repair with AI instead of the single generated-run action', () => {
    mountSaved(true);
    expect(screen.getByRole('button', { name: 'Run again exactly' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Repair with AI' })).toBeTruthy();
    cleanup(); mountSaved(false);
    expect(screen.queryByRole('button', { name: 'Run again exactly' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Repair with AI' })).toBeNull();
  });
  it('posts one replay on a double click and opens the new run', async () => {
    const user = userEvent.setup();
    mock.replay.mockResolvedValue({ execution: { id: 12 } });
    mountSaved(true);
    await user.dblClick(screen.getByRole('button', { name: 'Run again exactly' }));
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledWith({ to: '/tasks/$taskId/runs/$executionId', params: { taskId: '3', executionId: '12' } }));
    expect(mock.replay).toHaveBeenCalledTimes(1);
    expect(mock.retry).not.toHaveBeenCalled();
  });
  it('shows the one-open-run message from the server', async () => {
    const user = userEvent.setup();
    mock.replay.mockRejectedValue(new AutoMateError(ERROR_CODES.TASK_HAS_OPEN_RUN, 'Run 11 is waiting for your go-ahead. Finish or cancel it first.'));
    mountSaved(true);
    await user.click(screen.getByRole('button', { name: 'Run again exactly' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Run 11 is waiting for your go-ahead');
  });
});
