import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AutoMateError, ERROR_CODES, type Task, type TaskCounts } from '@automate/core';
import { TaskHeader } from '../../../components/history/task-header';

const mock = vi.hoisted(() => ({ navigate: vi.fn(), delete: vi.fn(), abort: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mock.navigate }));
vi.mock('../../../api/history-queries', () => ({ useDeleteTask: () => ({ mutate: mock.delete, isPending: false, isError: false }) }));
vi.mock('../../../api/task-queries', () => ({ useAbortExecution: () => ({ mutate: mock.abort, isPending: false, isError: false }) }));

const task: Task = { id: 3, name: '<script>Monthly report</script>', description: 'Report', createdAt: '2026-09-26T10:00:00.000Z', updatedAt: '2026-09-26T10:00:00.000Z' };
const counts: TaskCounts = { runs: 3, inputs: 2, outputs: 5, openRunId: null };
let root: HTMLDivElement;
function mount(value = counts, client = new QueryClient()) {
  return render(<QueryClientProvider client={client}><TaskHeader task={task} counts={value} /></QueryClientProvider>, { container: root });
}
beforeEach(() => {
  mock.navigate.mockReset(); mock.delete.mockReset(); mock.abort.mockReset();
  mock.navigate.mockResolvedValue(undefined);
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
});
afterEach(() => { cleanup(); root.remove(); sessionStorage.clear(); });

describe('delete task dialog', () => {
  it('says a saved task made from this task is kept, exactly when there is one', async () => {
    const user = userEvent.setup();
    const sentence = "This task was saved as 'Monthly sales'. The saved task keeps its own copy of the code and column names and is not deleted.";
    mount({ ...counts, savedAs: ['Monthly sales'] }); await user.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(screen.getByText(sentence)).toBeTruthy();
    cleanup(); root = document.createElement('div'); root.id = 'root'; document.body.append(root);
    mount({ ...counts, savedAs: [] }); await user.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(screen.queryByText(/This task was saved as/)).toBeNull();
  });

  it('treats a task another tab already deleted as gone: History, no error panel', async () => {
    const user = userEvent.setup();
    mock.delete.mockImplementation((_body, options) => options.onError(new AutoMateError(ERROR_CODES.TASK_NOT_FOUND, 'Task 3 was not found.')));
    mount(); await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await user.click(screen.getByRole('alertdialog').querySelector('button:last-child')!);
    expect(mock.navigate).toHaveBeenCalledWith({ to: '/history' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('removes the cached task queries and refreshes History after a delete', async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    client.setQueryData(['task', '3'], { task, executions: [], counts });
    client.setQueryData(['history', 'all', ''], { pages: [] });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mock.delete.mockImplementation((_body, options) => options.onSuccess({ taskId: 3, removed: { runs: 3, inputs: 2, outputs: 5 }, filesPendingRemoval: 0 }));
    mount(counts, client); await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await user.click(screen.getByRole('alertdialog').querySelector('button:last-child')!);
    expect(client.getQueryData(['task', '3'])).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['history'] });
    expect(sessionStorage.getItem('automate:history-announcement')).toBe('Task deleted.');
  });

  it('re-reads the counts after Cancel that run', async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mock.abort.mockImplementation((_body, options) => options.onSuccess());
    mount({ ...counts, openRunId: 12 }, client); await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await user.click(screen.getByRole('button', { name: 'Cancel that run' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task', '3'] });
  });

  it('names the complete deletion, traps focus on open, and restores it after Escape', async () => {
    const user = userEvent.setup(); mount();
    const trigger = screen.getByRole('button', { name: 'Delete task' });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog').textContent).toContain('3 runs, 2 input files, and 5 outputs');
    expect(screen.getByRole('alertdialog').textContent).toContain("can't be undone");
    expect(screen.getByRole('alertdialog').textContent).toContain('<script>Monthly report</script>');
    expect(document.querySelector('script')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep task' }));
    expect(root.inert).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(root.inert).toBe(false);
  });

  it('posts deletion once and announces files pending removal on History', async () => {
    const user = userEvent.setup();
    mock.delete.mockImplementation((_body, options) => options.onSuccess({ filesPendingRemoval: 1 }));
    mount(); await user.click(screen.getByRole('button', { name: 'Delete task' }));
    await user.dblClick(screen.getByRole('alertdialog').querySelector('button:last-child')!);
    expect(mock.delete).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('automate:history-announcement')).toMatch(/removed the next time the app starts/);
    expect(mock.navigate).toHaveBeenCalledWith({ to: '/history' });
  });

  it('offers cancellation instead of deletion while a run remains open', async () => {
    const user = userEvent.setup(); mount({ ...counts, openRunId: 12 });
    await user.click(screen.getByRole('button', { name: 'Delete task' }));
    expect(screen.queryByRole('alertdialog')?.textContent).toContain('Run 12 is still open');
    expect(screen.getAllByRole('button', { name: 'Delete task' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel that run' }));
    expect(mock.abort).toHaveBeenCalledTimes(1);
    expect(mock.delete).not.toHaveBeenCalled();
  });
});
