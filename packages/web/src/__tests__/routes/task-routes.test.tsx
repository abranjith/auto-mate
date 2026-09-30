// TASK-009: the task layout, its latest-run index, and a run's own address.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AutoMateError, ERROR_CODES, type RunTimelineItem } from '@automate/core';
import { RunView } from '../../components/history/run-view';

const mock = vi.hoisted(() => ({ params: {} as Record<string, string>, pathname: '/', task: vi.fn(), execution: vi.fn(), timeline: vi.fn(), pages: [] as unknown[] }));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options, useParams: () => mock.params, useSearch: () => ({}) }),
  Outlet: () => <div>outlet</div>,
  Navigate: ({ to, params }: { to: string; params: Record<string, string> }) => <p>redirect {to} {JSON.stringify(params)}</p>,
  Link: ({ children, ...props }: { children: ReactNode; 'aria-current'?: 'page' }) => <a href="/run" aria-current={props['aria-current']}>{children}</a>,
  useLocation: () => ({ pathname: mock.pathname }),
  useParams: () => mock.params,
  useNavigate: () => vi.fn(),
}));
vi.mock('../../api/task-queries', () => ({ getTask: mock.task, getExecution: mock.execution, useAbortExecution: () => ({ mutate: vi.fn() }) }));
vi.mock('../../api/history-queries', () => ({
  getRunTimeline: mock.timeline,
  useRunTimeline: () => ({ data: { pages: mock.pages }, hasNextPage: false, isError: false, fetchNextPage: vi.fn() }),
  useDeleteTask: () => ({ mutate: vi.fn() }),
}));
vi.mock('../../components/history/run-view', () => ({ RunView: vi.fn(({ executionId }: { executionId: number }) => <p>run view {executionId}</p>) }));
vi.mock('../../components/history/task-inputs', () => ({ TaskInputs: () => null }));

const at = '2026-09-26T10:00:00.000Z';
const component = async (path: string) => ((await import(path)) as { Route: { options: { component: () => ReactNode } } }).Route.options.component;
function mount(Component: () => ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Component /></QueryClientProvider>);
}
const timelineItem = (id: number): RunTimelineItem => ({ id, taskId: 3, runNumber: id - 9, status: 'failed', trigger: id === 10 ? 'manual' : 'rerun', retryOfExecutionId: id === 10 ? null : id - 1, hasGuidance: false, hasReviewFeedback: false, reason: null, savedAs: [], createdAt: at, completedAt: at, durationMs: 5, errorCode: null, outputCount: 0, reuse: null });

beforeEach(() => { vi.mocked(RunView).mockClear(); mock.task.mockReset(); mock.execution.mockReset(); mock.timeline.mockReset(); mock.pages = []; });
afterEach(cleanup);

describe('task layout /tasks/$taskId', () => {
  it('renders the prompt verbatim as text, newlines and markup included', async () => {
    mock.params = { taskId: '3' };
    const description = 'Line one\n<script>alert(1)</script>\n=SUM(A1)';
    mock.task.mockResolvedValue({ task: { id: 3, name: 'Monthly', description, createdAt: at, updatedAt: at }, executions: [], counts: { runs: 1, inputs: 0, outputs: 0, openRunId: null } });
    const view = mount(await component('../../routes/tasks.$taskId'));
    await waitFor(() => expect(view.container.textContent).toContain('What you asked'));
    const prompt = [...view.container.querySelectorAll('p')].find((element) => element.textContent === description);
    expect(prompt).toBeDefined();
    expect(view.container.querySelector('script')).toBeNull();
    expect(screen.getByText('outlet')).toBeTruthy();
  });

  it('says a missing task was deleted or never existed, and links back to History', async () => {
    mock.params = { taskId: '99' };
    mock.task.mockRejectedValue(new AutoMateError(ERROR_CODES.TASK_NOT_FOUND, 'Task 99 was not found.'));
    const view = mount(await component('../../routes/tasks.$taskId'));
    await waitFor(() => expect(view.container.textContent).toContain('This task was deleted or never existed.'));
    expect(screen.getByRole('link', { name: 'Back to History' }).getAttribute('href')).toBe('/history');
  });

  it('marks exactly the selected run as current in the lineage', async () => {
    mock.pages = [{ items: [timelineItem(12), timelineItem(11), timelineItem(10)], nextCursor: null, hasMore: false }];
    mock.pathname = '/tasks/3/runs/11';
    const { LineageRail } = await import('../../components/history/lineage-rail');
    const view = render(<LineageRail taskId={3} currentExecutionId={11} />);
    const current = view.container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('Run 2');
  });

  it('numbers runs per task in chronological order', async () => {
    mock.pages = [{ items: [{ ...timelineItem(12), durationMs: 83_787, outputCount: 1 }, { ...timelineItem(11), durationMs: 5_934 }, timelineItem(10)], nextCursor: null, hasMore: false }];
    mock.pathname = '/tasks/3/runs/12';
    const { LineageRail } = await import('../../components/history/lineage-rail');
    const text = render(<LineageRail taskId={3} />).container.textContent ?? '';
    expect(text.indexOf('Run 1')).toBeLessThan(text.indexOf('Run 2'));
    expect(text.indexOf('Run 2')).toBeLessThan(text.indexOf('Run 3'));
    expect(text).not.toMatch(/\d ms/);
    expect(text).not.toContain('Run 12');
  });
});

describe('run routes', () => {
  it('shows the latest run at /tasks/$taskId', async () => {
    mock.params = { taskId: '3' };
    mock.timeline.mockResolvedValue({ items: [timelineItem(12), timelineItem(11)], nextCursor: null, hasMore: false });
    mount(await component('../../routes/tasks.$taskId.index'));
    await waitFor(() => expect(screen.getByText('run view 12')).toBeTruthy());
  });

  it('shows the requested run at /tasks/$taskId/runs/$executionId', async () => {
    mock.params = { taskId: '3', executionId: '11' };
    mock.execution.mockResolvedValue({ id: 11, taskId: 3 });
    mount(await component('../../routes/tasks.$taskId.runs.$executionId.index'));
    await waitFor(() => expect(screen.getByText('run view 11')).toBeTruthy());
  });

  it('redirects a run shown under another task\'s address to its own task', async () => {
    mock.params = { taskId: '4', executionId: '11' };
    mock.execution.mockResolvedValue({ id: 11, taskId: 3 });
    mount(await component('../../routes/tasks.$taskId.runs.$executionId.index'));
    await waitFor(() => expect(screen.getByText(/redirect/).textContent).toContain('{"taskId":"3"}'));
    expect(RunView).not.toHaveBeenCalled();
  });
});
