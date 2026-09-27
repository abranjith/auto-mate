import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { ExecutionStatus } from '@automate/core';
import { HistoryList } from '../../../components/history/history-list';
import { ds } from '../../../design-system/tokens';

const mock = vi.hoisted(() => ({ history: vi.fn(), navigate: vi.fn(), more: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mock.navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="/task">{children}</a>,
}));
vi.mock('../../../api/history-queries', () => ({ useTaskHistory: mock.history }));

const at = '2026-09-26T10:00:00.000Z';
const item = (id: number, status: ExecutionStatus, overrides: { name?: string; errorCode?: string | null; trigger?: 'manual' | 'rerun' | 'feedback' } = {}) => ({
  task: { id, name: overrides.name ?? `Task ${id}`, createdAt: at },
  latestRun: { id, status, trigger: overrides.trigger ?? 'manual', createdAt: at, completedAt: null, durationMs: null, errorCode: overrides.errorCode ?? null, statusSince: at },
  runCount: 2, inputCount: 1, latestOutputCount: 3,
});
type Item = ReturnType<typeof item>;
const query = (items: Item[], hasNextPage = false) => ({ data: { pages: [{ items }] }, isPending: false, isError: false, hasNextPage, isFetchingNextPage: false, fetchNextPage: mock.more, refetch: vi.fn() });
/** Every `status|q` pair the list was queried with. */
const listQueries = () => mock.history.mock.calls.map(([status, q]) => `${String(status)}|${String(q)}`);

beforeEach(() => {
  mock.history.mockReset(); mock.navigate.mockReset(); mock.more.mockReset();
  mock.navigate.mockResolvedValue(undefined); mock.more.mockResolvedValue(undefined);
  mock.history.mockImplementation((status: string) => status === 'needs_you' ? query([item(1, 'awaiting_approval')]) : query([item(1, 'awaiting_approval'), item(2, 'completed')], true));
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });

describe('History list', () => {
  it('shows parked work above task rows, with latest state and counts', async () => {
    render(<HistoryList />);
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy();
    expect(screen.getByText(/Task 1.*Approve the run/)).toBeTruthy();
    expect(screen.getAllByText('Task 1')).toHaveLength(1);
    expect(screen.getByText('Waiting for your go-ahead')).toBeTruthy();
    expect(screen.getAllByText(/2 runs.*1 input.*3 outputs/)).toHaveLength(2);
  });

  it('labels an interrupted run and one stopped on shutdown, never as Cancelled, and every badge carries text', () => {
    mock.history.mockImplementation((status: string) => status === 'needs_you' ? query([]) : query([item(1, 'failed', { errorCode: 'EXECUTION_INTERRUPTED' }), item(2, 'aborted', { errorCode: 'EXECUTION_STOPPED_ON_SHUTDOWN' }), item(3, 'failed', { trigger: 'rerun' })]));
    const view = render(<HistoryList />);
    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(screen.getByText('Stopped when the app closed')).toBeTruthy();
    expect(screen.queryByText('Cancelled')).toBeNull();
    expect(screen.getByText('Tried again')).toBeTruthy();
    const badges = [...view.container.querySelectorAll('span')].filter((element) => element.className === ds.badge);
    expect(badges).toHaveLength(3);
    for (const badge of badges) expect(badge.textContent?.trim()).not.toBe('');
  });

  it('renders hostile task names as literal text', () => {
    const names = ['<img src=x onerror=alert(1)>', "=cmd|'/c calc'!A1"];
    mock.history.mockImplementation((status: string) => status === 'needs_you' ? query([]) : query(names.map((name, index) => item(index + 1, 'completed', { name }))));
    const view = render(<HistoryList />);
    for (const name of names) expect(screen.getByText(name)).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('appends the next page on Load more and moves focus to its first new item', async () => {
    let items = [item(1, 'awaiting_approval'), item(2, 'completed')];
    mock.history.mockImplementation((status: string) => status === 'needs_you' ? query([]) : query(items, items.length < 3));
    const view = render(<HistoryList />);
    mock.more.mockImplementation(async () => { items = [...items, item(3, 'completed')]; view.rerender(<HistoryList />); });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));
    expect(mock.more).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Task 3'));
    expect(screen.getAllByRole('listitem').map((element) => element.querySelector('a')?.textContent)).toEqual(['Task 1', 'Task 2', 'Task 3']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('issues one search after the debounce, not one per keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<HistoryList />);
    await user.type(screen.getByRole('textbox', { name: 'Search your tasks' }), 'sales');
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const searched = new Set(listQueries().filter((entry) => entry.startsWith('all|')));
    expect(searched).toEqual(new Set(['all|', 'all|sales']));
    expect(mock.navigate).toHaveBeenLastCalledWith({ to: '/history', search: { status: 'all', q: 'sales' }, replace: true });
  });

  it('keeps filter and search in the address and offers a reset for empty results', async () => {
    const user = userEvent.setup();
    mock.history.mockImplementation(() => query([]));
    render(<HistoryList />);
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Needs you' }));
    expect(mock.navigate).toHaveBeenCalledWith({ to: '/history', search: { status: 'needs_you', q: '' }, replace: true });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true');
    await user.type(screen.getByRole('textbox', { name: 'Search your tasks' }), 'sales');
    await waitFor(() => expect(mock.navigate).toHaveBeenCalledWith({ to: '/history', search: { status: 'done', q: 'sales' }, replace: true }));
    expect(screen.getByText('No tasks match.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('restores both controls from the address on reload', () => {
    render(<HistoryList status="done" q="sales" />);
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Search your tasks' }) as HTMLInputElement).value).toBe('sales');
    expect(mock.history).toHaveBeenCalledWith('done', 'sales');
  });
});
