import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SAVED_TASK_KEEPS, type SavePreviewResponse } from '@automate/core';
import { SaveTaskDialog } from '../../../components/saved/save-task-dialog';

const mock = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/saved/1">{children}</a>, useNavigate: () => mock.navigate }));
vi.mock('../../../api/template-queries', () => ({ getSavePreview: mock.preview, saveExecution: mock.save }));
const preview: SavePreviewResponse = { saveable: true, reason: null, alreadySaved: null, defaultName: 'Sales totals', promoteTarget: null, keeps: { inputs: [{ label: 'sales.xlsx', format: 'xlsx', sheets: ['Sheet1'], requiredColumns: ['Amount'] }], ruleCount: 1, noteCount: 0 }, readsWallClock: [{ path: 'main.py', line: 8 }] };
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SaveTaskDialog executionId={4} /></QueryClientProvider>);
beforeEach(() => { mock.preview.mockReset().mockResolvedValue(preview); mock.save.mockReset().mockResolvedValue({ template: { id: 7 }, revision: { id: 8 } }); mock.navigate.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);

describe('SaveTaskDialog', () => {
  it('shows retained names and clock reads before saving, and submits once on a double click', async () => {
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', { name: 'Save this task' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(SAVED_TASK_KEEPS)).toBeTruthy();
    expect(screen.getByText(/sales.xlsx/)).toBeTruthy();
    expect(screen.getByText(/Sheet1/)).toBeTruthy();
    expect(screen.getByText(/main.py:8/)).toBeTruthy();
    await user.dblClick(screen.getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(mock.save).toHaveBeenCalledTimes(1));
    expect(mock.save).toHaveBeenCalledWith(4, { name: 'Sales totals' });
  });

  it('offers promotion and a separate new saved task', async () => {
    mock.preview.mockResolvedValue({ ...preview, promoteTarget: { templateId: 3, name: 'Quarterly totals', nextRevisionNumber: 2 } });
    const user = userEvent.setup(); mount();
    await user.click(await screen.findByRole('button', { name: 'Save this task' }));
    expect(screen.getByRole('button', { name: "Save as revision 2 of 'Quarterly totals'" })).toBeTruthy();
    await user.click(screen.getByLabelText('Save as a new saved task'));
    expect(screen.getByRole('button', { name: 'Save task' })).toBeTruthy();
  });

  it('links an already saved run without offering another save', async () => {
    mock.preview.mockResolvedValue({ ...preview, saveable: false, alreadySaved: { templateId: 3, name: 'Quarterly totals', revisionNumber: 2 } });
    mount();
    expect(await screen.findByRole('link', { name: 'Quarterly totals' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save this task' })).toBeNull();
  });
});
