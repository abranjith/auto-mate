import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { RunTimelineItem } from '@automate/core';
import { LineageRail } from '../../../components/history/lineage-rail';

const mock = vi.hoisted(() => ({ pages: [] as { items: RunTimelineItem[] }[], hasNextPage: false, isError: false, fetchNextPage: vi.fn() }));
vi.mock('../../../api/history-queries', () => ({ useRunTimeline: () => ({ data: { pages: mock.pages }, hasNextPage: mock.hasNextPage, isError: mock.isError, fetchNextPage: mock.fetchNextPage }) }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params: Record<string, string>; 'aria-current'?: 'page' }) => <a href={to.replace('$taskId', params.taskId ?? '').replace('$executionId', params.executionId ?? '').replace('$templateId', params.templateId ?? '')} aria-current={rest['aria-current']}>{children}</a> }));

const at = '2026-09-26T10:00:00.000Z';
const item = (id: number): RunTimelineItem => ({ id, taskId: 3, runNumber: id, status: 'completed', trigger: id === 1 ? 'manual' : 'rerun', retryOfExecutionId: id === 1 ? null : id - 1, hasGuidance: id > 1, hasReviewFeedback: false, reason: id > 1 ? 'Use totals' : null, savedAs: [], createdAt: at, completedAt: at, durationMs: 1000, errorCode: null, outputCount: 0, reuse: null });
afterEach(() => { cleanup(); mock.pages = []; mock.hasNextPage = false; mock.isError = false; mock.fetchNextPage.mockClear(); });

describe('LineageRail', () => {
  it('shows runs oldest first, with an edge and one current run', () => {
    mock.pages = [{ items: [item(3), item(2), item(1)] }];
    const view = render(<LineageRail taskId={3} currentExecutionId={2} />);
    const text = view.container.textContent ?? '';
    expect(text.indexOf('Run 1')).toBeLessThan(text.indexOf('Run 2'));
    expect(text.indexOf('Run 2')).toBeLessThan(text.indexOf('Run 3'));
    expect(screen.getAllByText('Tried again with your guidance')).toHaveLength(2);
    expect(view.container.querySelector('[aria-current="page"]')?.textContent).toBe('Run 2');
  });

  it('quotes words as text and links saved revisions and task origins', () => {
    mock.pages = [{ items: [{ ...item(2), reason: '<b>x</b>', savedAs: [{ templateId: 7, name: 'Monthly', revisionNumber: 2 }] }, { ...item(1), reuse: { kind: 'run', templateId: 7, templateName: 'Monthly', revisionNumber: 1 } }] }];
    const view = render(<LineageRail taskId={3} />);
    expect(view.container.textContent).toContain('“<b>x</b>”');
    expect(view.container.querySelector('b')).toBeNull();
    expect(screen.getByRole('link', { name: 'Saved as Monthly (revision 2)' }).getAttribute('href')).toBe('/saved/7');
    expect(view.container.textContent?.indexOf('Ran “Monthly”')).toBeLessThan(view.container.textContent?.indexOf('Run 1') ?? 0);
  });

  it('loads earlier runs at the start and reports timeline failures', async () => {
    const user = userEvent.setup();
    mock.pages = [{ items: [item(2)] }]; mock.hasNextPage = true;
    const view = render(<LineageRail taskId={3} />);
    expect(view.container.querySelector('li')?.textContent).toBe('Show earlier runs');
    await user.click(screen.getByRole('button', { name: 'Show earlier runs' }));
    expect(mock.fetchNextPage).toHaveBeenCalledTimes(1);
    mock.isError = true; view.rerender(<LineageRail taskId={3} />);
    expect(screen.getByText('The runs could not be loaded.')).toBeTruthy();
  });
});
