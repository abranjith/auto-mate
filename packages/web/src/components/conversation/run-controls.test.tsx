import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AutoMateError,
  ERROR_CODES,
  EXECUTION_STATUSES,
  type ExecutionSummary,
} from '@automate/core';
import { ExecutionStatusBadge } from './execution-status-badge';
import { FailurePanel } from './failure-panel';
import { CompletedSummary, RunControls } from './run-controls';
const mock = vi.hoisted(() => ({
  mutation: {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  },
}));
vi.mock('../../api/task-queries', () => ({
  useAbortExecution: () => mock.mutation,
}));
const base: ExecutionSummary = {
  id: 1,
  taskId: 1,
  status: 'generating',
  provider: null,
  model: null,
  usage: {},
  startedAt: null,
  completedAt: null,
  durationMs: null,
  error: null,
  createdAt: '2026-09-22T00:00:00.000Z',
};
function renderControl(execution = base) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RunControls execution={execution} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mock.mutation.mutate = vi.fn();
  mock.mutation.isPending = false;
  mock.mutation.isError = false;
  mock.mutation.error = null;
});
afterEach(cleanup);
describe('run terminal controls', () => {
  it('labels every status and shows cancel only before terminal state', () => {
    for (const status of EXECUTION_STATUSES) {
      const view = render(<ExecutionStatusBadge status={status} />);
      expect(screen.getByRole('status').textContent).toBeTruthy();
      view.unmount();
    }
    renderControl();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeTruthy();
    cleanup();
    renderControl({ ...base, status: 'completed' });
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
  });
  it('calls abort once and explains a stale terminal request', async () => {
    const user = userEvent.setup();
    mock.mutation.isError = true;
    mock.mutation.error = new AutoMateError(
      ERROR_CODES.EXECUTION_NOT_RUNNING,
      'raw',
    );
    renderControl();
    await user.click(screen.getByRole('button'));
    expect(mock.mutation.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('already finished');
  });
  it('renders safe interrupted copy and omits absent completion metrics', () => {
    const { container } = render(
      <>
        <FailurePanel
          error={{
            code: 'EXECUTION_INTERRUPTED',
            message: 'C:\\private\\stack\nat x',
          }}
        />
        <CompletedSummary execution={{ ...base, status: 'completed' }} />
      </>,
    );
    expect(screen.getByRole('alert').textContent).toContain('server restarted');
    expect(container.textContent).not.toMatch(/private|at x/);
    expect(container.textContent).not.toMatch(/turn|\$/);
  });
});
