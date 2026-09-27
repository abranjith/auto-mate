// FEAT-111 TASK-011/012: the Saved tasks list, one saved task, and running it with another file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { REUSE_NOTHING_SENT, type CompatibilityResponse, type TemplateDetailResponse, type TemplateListResponse, type UploadResponse } from '@automate/core';

const HOSTILE = '<img src=x onerror=alert(1)>';
const mock = vi.hoisted(() => ({ params: {} as Record<string, string>, navigate: vi.fn(), templates: { pages: [] as TemplateListResponse[], hasNextPage: false, fetchNextPage: vi.fn() }, detail: undefined as TemplateDetailResponse | undefined, revision: vi.fn(), compatibility: vi.fn(), start: vi.fn(), repair: vi.fn(), slotUploads: [] as (UploadResponse | null)[] }));
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options, useParams: () => mock.params }),
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
  Outlet: () => null,
  useNavigate: () => mock.navigate,
}));
vi.mock('../../api/template-queries', () => ({
  useTemplates: () => ({ isPending: false, isError: false, data: { pages: mock.templates.pages }, hasNextPage: mock.templates.hasNextPage, isFetchingNextPage: false, fetchNextPage: mock.templates.fetchNextPage }),
  useTemplate: () => ({ isPending: false, isError: false, data: mock.detail }),
  useTemplateRuns: () => ({ isPending: false, data: { pages: [{ items: [] }] }, hasNextPage: false, fetchNextPage: vi.fn() }),
  getTemplateRevision: mock.revision,
  deleteTemplate: vi.fn(),
  getCompatibility: mock.compatibility,
  startTemplateRun: mock.start,
  startTemplateRepair: mock.repair,
}));
vi.mock('../../api/task-queries', () => ({ getExecution: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('../../components/saved/slot-composer', () => ({ SlotComposer: ({ position, onChange }: { position: number; onChange: (upload: UploadResponse | null) => void }) => <button type="button" onClick={() => onChange(mock.slotUploads[position] ?? null)}>attach {position + 1}</button> }));
vi.mock('../../components/saved/repair-review', () => ({ RepairReview: ({ instructions }: { instructions: string }) => <p>review: {instructions}</p> }));

const at = '2026-09-26T10:00:00.000Z';
const component = async (path: string) => ((await import(path)) as { Route: { options: { component: () => ReactNode } } }).Route.options.component;
const mount = (Component: () => ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Component /></QueryClientProvider>);
const detail = (name = 'Monthly sales'): TemplateDetailResponse => ({
  template: { id: 1, name, description: 'Sum sales by region.', createdAt: at, updatedAt: at },
  currentRevision: { id: 5, number: 2, createdAt: at, contentDigestShort: 'abc123', summary: HOSTILE, declaredOutputs: [{ filename: 'totals.csv', type: 'csv', title: HOSTILE, description: '' }], inputs: [{ position: 0, inputName: '12-sales.csv', label: 'sales_q1.xlsx', format: 'xlsx', sourceSha256: 'a'.repeat(64), declared: true, tables: [{ selector: { kind: 'sheet', name: 'Sheet1' }, columns: [{ name: HOSTILE, position: 0, sourceType: 'decimal', temporalFormat: null, required: true, declaredType: 'decimal' }, { name: 'When', position: 1, sourceType: 'date', temporalFormat: 'DD/MM/YYYY', required: true, declaredType: null }] }] }], rules: [{ inputPosition: 0, table: { kind: 'sheet', name: 'Sheet1' }, column: 'When', kind: 'ambiguous_date_format', answer: 'DD/MM/YYYY', question: HOSTILE }], notes: [{ question: '=HYPERLINK("x")', answer: 'yes' }], runtimeLine: 'Python 3.14.6 on linux · 9 packages', readsWallClock: [{ path: 'main.py', line: 4 }], note: null },
  revisions: [{ id: 5, number: 2, createdAt: at, sourceExecutionId: null, note: 'In the first file, use the column “Total”.' }, { id: 4, number: 1, createdAt: at, sourceExecutionId: 9, note: null }],
});
const compat = (status: CompatibilityResponse['report']['status']): CompatibilityResponse => ({ digest: 'd'.repeat(64), asOf: { at: 1, date: '2026-09-26', timeZone: 'UTC', source: 'now' }, report: { version: 1, templateId: 1, revisionNumber: 2, contractDigest: 'c'.repeat(64), status, inputs: [], findings: status === 'incompatible' ? [{ code: 'column_missing', severity: 'blocking', inputPosition: 0, sheet: 'Sheet1', column: 'Amount', expected: 'decimal', found: null, suggestion: null }] : [], rules: { applied: 0, notNeeded: 0, conflicts: 0, unrecorded: 0 }, runtime: { revision: 'a', current: 'a', changes: [] }, asOf: { at: 1, date: '2026-09-26', timeZone: 'UTC', source: 'now' } } });

beforeEach(() => {
  mock.navigate.mockReset().mockResolvedValue(undefined); mock.revision.mockReset(); mock.compatibility.mockReset(); mock.start.mockReset(); mock.repair.mockReset();
  mock.templates = { pages: [], hasNextPage: false, fetchNextPage: vi.fn() }; mock.detail = detail(); mock.params = { templateId: '1' };
  mock.slotUploads = [{ upload: { id: 30 }, profiles: [{ sheetName: 'Sheet1', sheetIndex: 0, columns: [{ name: 'Total', position: 0 }] }] } as unknown as UploadResponse];
});
afterEach(cleanup);

describe('/saved', () => {
  it('shows the empty state', async () => {
    mount(await component('../../routes/saved.index'));
    expect(screen.getByText('No saved tasks yet. When a run does what you wanted, choose Save this task.')).toBeTruthy();
  });
  it('lists names as text with revision and run counts, and loads more', async () => {
    const user = userEvent.setup();
    mock.templates = { pages: [{ items: [{ id: 1, name: HOSTILE, currentRevisionNumber: 2, revisionCount: 2, runCount: 5, lastRunAt: null, createdAt: at }], nextCursor: 1, hasMore: true }], hasNextPage: true, fetchNextPage: vi.fn() };
    const { container } = mount(await component('../../routes/saved.index'));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(HOSTILE)).toBeTruthy();
    expect(screen.getByText(/Revision 2 · never run · 5 runs/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(mock.templates.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

describe('/saved/$templateId', () => {
  it('renders every section with untrusted text as literal text and plain type words', async () => {
    const { container } = mount(await component('../../routes/saved.$templateId.index'));
    for (const heading of ['What it expects', 'What it produces', 'Choices it remembers', 'Checked on', 'Revisions', 'Runs']) expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    expect(container.textContent).toContain('=HYPERLINK("x")');
    expect(screen.getByRole('cell', { name: 'numbers' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'dates' })).toBeTruthy();
    expect(screen.getByText(/main.py:4/)).toBeTruthy();
    expect(screen.getByText('From a task since deleted')).toBeTruthy();
  });
  it('fetches revision code only when Show the code is opened, once', async () => {
    mock.revision.mockResolvedValue({ revision: {}, files: [] });
    const { container } = mount(await component('../../routes/saved.$templateId.index'));
    expect(mock.revision).not.toHaveBeenCalled();
    const details = container.querySelector('details')!;
    details.open = true; details.dispatchEvent(new Event('toggle'));
    await waitFor(() => expect(mock.revision).toHaveBeenCalledTimes(1));
    expect(mock.revision).toHaveBeenCalledWith(5);
  });
});

describe('/saved/$templateId/run', () => {
  it('checks nothing until every slot has a file, then offers Start with the nothing-sent sentence', async () => {
    const user = userEvent.setup();
    mock.compatibility.mockResolvedValue(compat('compatible'));
    mock.start.mockResolvedValue({ task: { id: 44 }, execution: { id: 45 } });
    mount(await component('../../routes/saved.$templateId.run'));
    expect(screen.getByText(/Choose and analyze a file for every slot/)).toBeTruthy();
    expect(mock.compatibility).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'attach 1' }));
    expect(await screen.findByText(REUSE_NOTHING_SENT)).toBeTruthy();
    await user.dblClick(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(mock.start).toHaveBeenCalledTimes(1));
    expect(mock.start).toHaveBeenCalledWith(1, expect.objectContaining({ uploadIds: [30], compatibilityDigest: 'd'.repeat(64) }));
    expect(mock.navigate).toHaveBeenCalledWith({ to: '/tasks/$taskId', params: { taskId: '44' } });
  });
  it('has no Start for an incompatible file and asks the mapping question instead', async () => {
    const user = userEvent.setup();
    mock.compatibility.mockResolvedValue(compat('incompatible'));
    mount(await component('../../routes/saved.$templateId.run'));
    await user.click(screen.getByRole('button', { name: 'attach 1' }));
    expect(await screen.findByText(/Which column in your new file holds the same thing\?/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox'), 'Total');
    await user.click(screen.getByRole('button', { name: 'Continue to review' }));
    expect(screen.getByText(/review: .*use the column “Total” wherever the saved task used “Amount”/s)).toBeTruthy();
  });
  it('refetches the check when the start is stale, without a second start', async () => {
    const user = userEvent.setup();
    mock.compatibility.mockResolvedValue(compat('compatible'));
    mock.start.mockRejectedValue(Object.assign(new Error('The check changed since you looked. Please look again.'), { code: 'COMPATIBILITY_STALE' }));
    mount(await component('../../routes/saved.$templateId.run'));
    await user.click(screen.getByRole('button', { name: 'attach 1' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('The check changed since you looked. Please look again.')).toBeTruthy();
    await waitFor(() => expect(mock.compatibility).toHaveBeenCalledTimes(2));
    expect(mock.start).toHaveBeenCalledTimes(1);
  });
});
