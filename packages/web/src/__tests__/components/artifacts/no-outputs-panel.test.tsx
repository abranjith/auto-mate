import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LIMIT_BREACHES, SCRIPT_RUN_STATUSES, describeLimitBreach, describeRunOutcome, type LimitBreach, type NextStepAction } from '@automate/core';
import { NoOutputsPanel, needsOutcomePanel } from '../../../components/artifacts/no-outputs-panel';
import { artifact, list, run } from './artifact-fixtures';

afterEach(cleanup);

/** The control each action must render, found by its role and its label. */
const CONTROL_ROLE: Readonly<Record<NextStepAction, 'link' | 'button'>> = { review_result: 'link', download_produced: 'link', retry_with_detail: 'button', adjust_request: 'button', open_transcript: 'link', prepare_runtime: 'link', cancel: 'button' };

describe('NoOutputsPanel', () => {
  it('renders every outcome with at least one next step whose control is on the screen', () => {
    let cells = 0;
    for (const status of SCRIPT_RUN_STATUSES) for (const limitBreached of [null, ...LIMIT_BREACHES] as (LimitBreach | null)[]) for (const manifestPresent of [true, false, null]) for (const count of [0, 2]) {
      const artifacts = list(Array.from({ length: count }, (_, index) => artifact({ id: index + 1 })));
      const view = run({ status, limitBreached, manifestPresent, exitCode: status === 'failed' ? 1 : 0 });
      const { unmount } = render(<NoOutputsPanel run={view} artifacts={artifacts} onRetry={() => Promise.resolve()} onCancel={() => undefined} />);
      const outcome = describeRunOutcome({ ...view, missingDeclaredCount: 0 }, artifacts.artifacts);
      const steps = within(screen.getByRole('list', { name: 'Next steps' })).getAllByRole('listitem');
      expect(steps.length).toBeGreaterThan(0);
      outcome.nextSteps.forEach((step, index) => {
        const control = within(steps[index]!).getByRole(CONTROL_ROLE[step.action], { name: step.label });
        expect((control as HTMLButtonElement).disabled ?? false).toBe(false);
        if (CONTROL_ROLE[step.action] === 'link') expect(control.getAttribute('href')).toMatch(/^(#review|#transcript|\/settings|\/api\/)/);
      });
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/Traceback|[A-Za-z]:\\|\/home\/|\/Users\//);
      expect(screen.getByRole('heading').textContent).not.toMatch(/exit code|\b\d{2,3}\b/);
      unmount();
      cells += 1;
    }
    expect(cells).toBe(SCRIPT_RUN_STATUSES.length * 5 * 3 * 2);
  }, 20_000);

  it('explains a zero-exit run with no manifest, and offers a working retry', async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    render(<NoOutputsPanel run={run({ status: 'failed', exitCode: 0, manifestPresent: false })} artifacts={list([])} onRetry={onRetry} />);
    expect(screen.getByRole('heading').textContent).toBe('The script finished but did not say what it produced.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again, telling me more about what you want' }));
    await userEvent.type(screen.getByRole('textbox'), 'Write the totals to a CSV and list it.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again with this' }));
    expect(onRetry).toHaveBeenCalledWith('Write the totals to a CSV and list it.');
  });

  it('refuses an empty retry with a sentence rather than sending nothing', async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    render(<NoOutputsPanel run={run({ status: 'failed', exitCode: 0, manifestPresent: false })} artifacts={list([])} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: /Try again, telling me more/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Try again with this' }));
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/Say what should be different/);
  });

  it('shows a retry that fails as a sentence', async () => {
    render(<NoOutputsPanel run={run({ status: 'failed', exitCode: 0, manifestPresent: false })} artifacts={list([])} onRetry={() => Promise.reject(new Error('Run 2 is still executing. Wait for it to finish or stop it before trying again.'))} />);
    await userEvent.click(screen.getByRole('button', { name: /Try again, telling me more/ }));
    await userEvent.type(screen.getByRole('textbox'), 'again');
    await userEvent.click(screen.getByRole('button', { name: 'Try again with this' }));
    expect((await screen.findByRole('alert')).textContent).toContain('still executing');
  });

  it('renders FEAT-108\'s timeout sentence verbatim, on its own line', () => {
    render(<NoOutputsPanel run={run({ status: 'timed_out', limitBreached: 'time', exitCode: null })} artifacts={list([])} onRetry={() => Promise.resolve()} />);
    expect(screen.getByText(describeLimitBreach('time'))).toBeTruthy();
    expect(screen.getByText(describeLimitBreach('time')).textContent).toBe(describeLimitBreach('time'));
  });

  it('names an output-bytes cap in human units', () => {
    render(<NoOutputsPanel run={run({ status: 'failed', limitBreached: 'output_bytes', exitCode: 94 })} artifacts={list([artifact()])} onRetry={() => Promise.resolve()} />);
    expect(screen.getByText(describeLimitBreach('output_bytes')).textContent).toMatch(/1 GB/);
    expect(screen.getByText('The 1 file it wrote before stopping is kept below.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download what it produced' }).getAttribute('href')).toBe('/api/artifacts/1/download');
  });

  it('gives both numbers for a run that declared three files and produced one, and offers that one', () => {
    const artifacts = list([artifact()], { declaredOutputCount: 3, discrepancies: [{ kind: 'missing', count: 2, message: 'x' }] });
    render(<NoOutputsPanel run={run({ status: 'failed', exitCode: 0, declaredOutputCount: 3 })} artifacts={artifacts} onRetry={() => Promise.resolve()} />);
    expect(screen.getByText(/said it would produce 3 files, but 2 were not written/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download what it produced' }).getAttribute('href')).toBe('/api/artifacts/1/download');
  });

  it('downloads a partial set of several files as the archive', () => {
    render(<NoOutputsPanel run={run({ status: 'aborted', exitCode: null })} artifacts={list([artifact({ id: 1 }), artifact({ id: 2, filename: 'b.csv' })])} onRetry={() => Promise.resolve()} />);
    expect(screen.getByRole('link', { name: 'Download what it produced' }).getAttribute('href')).toBe('/api/executions/2/artifacts/archive');
  });

  it('sends a run that could not start to Settings', () => {
    render(<NoOutputsPanel run={run({ status: 'errored', exitCode: null })} artifacts={list([])} onRetry={() => Promise.resolve()} />);
    expect(screen.getByRole('link', { name: 'Open Settings to prepare Python' }).getAttribute('href')).toBe('/settings');
  });
});

describe('needsOutcomePanel', () => {
  it('stays out of the way of a clean success with results, and appears for anything else', () => {
    expect(needsOutcomePanel(run(), list([artifact()]))).toBe(false);
    expect(needsOutcomePanel(run(), list([]))).toBe(true);
    expect(needsOutcomePanel(run({ status: 'failed', exitCode: 1 }), list([artifact()]))).toBe(true);
    expect(needsOutcomePanel(run({ limitBreached: 'memory' }), list([artifact()]))).toBe(true);
    expect(needsOutcomePanel(run(), list([artifact()], { discrepancies: [{ kind: 'missing', count: 1, message: 'm' }] }))).toBe(true);
    expect(needsOutcomePanel(run({ status: 'running' }), undefined)).toBe(false);
  });
});
