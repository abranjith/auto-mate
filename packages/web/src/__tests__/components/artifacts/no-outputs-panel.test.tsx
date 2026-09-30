import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { LIMIT_BREACHES, SCRIPT_RUN_STATUSES, describeLimitBreach, describeRunOutcome, type LimitBreach, type NextStepAction } from '@automate/core';
import { NoOutputsPanel, needsOutcomePanel } from '../../../components/artifacts/no-outputs-panel';
import { artifact, list, run } from './artifact-fixtures';

afterEach(cleanup);
const CONTROL_ROLE: Readonly<Record<NextStepAction, 'link' | 'button'>> = { review_result: 'link', download_produced: 'link', retry_with_detail: 'link', adjust_request: 'link', open_transcript: 'link', open_checks: 'link', prepare_runtime: 'link', cancel: 'button' };

describe('NoOutputsPanel', () => {
  it('renders every outcome with an actionable next step', () => {
    let cells = 0;
    for (const status of SCRIPT_RUN_STATUSES) for (const limitBreached of [null, ...LIMIT_BREACHES] as (LimitBreach | null)[]) for (const manifestPresent of [true, false, null]) for (const count of [0, 2]) {
      const artifacts = list(Array.from({ length: count }, (_, index) => artifact({ id: index + 1 })));
      const view = run({ status, limitBreached, manifestPresent, exitCode: status === 'failed' ? 1 : 0 });
      const { unmount } = render(<NoOutputsPanel run={view} artifacts={artifacts} onCancel={() => undefined} />);
      const outcome = describeRunOutcome({ ...view, missingDeclaredCount: 0 }, artifacts.artifacts);
      const steps = within(screen.getByRole('list', { name: 'Next steps' })).getAllByRole('listitem');
      expect(steps).toHaveLength(outcome.nextSteps.length);
      outcome.nextSteps.forEach((step, index) => expect(within(steps[index]!).getByRole(CONTROL_ROLE[step.action], { name: step.label })).toBeTruthy());
      expect(screen.queryByRole('textbox')).toBeNull();
      unmount(); cells++;
    }
    expect(cells).toBe(SCRIPT_RUN_STATUSES.length * 5 * 3 * 2);
  }, 20_000);

  it('links retry steps to the only retry control or review', () => {
    const result = run({ status: 'failed', exitCode: 0, manifestPresent: false });
    const view = render(<NoOutputsPanel run={result} artifacts={list([])} />);
    expect(screen.getByRole('link', { name: /Try again, telling me more/ }).getAttribute('href')).toBe('#run-again');
    view.rerender(<NoOutputsPanel run={result} artifacts={list([])} reviewing />);
    expect(screen.getByRole('link', { name: /Try again, telling me more/ }).getAttribute('href')).toBe('#review');
  });

  it('shows the exact timeout limit and partial outputs', () => {
    render(<NoOutputsPanel run={run({ status: 'timed_out', limitBreached: 'time', exitCode: null })} artifacts={list([artifact()])} />);
    expect(screen.getByText(describeLimitBreach('time'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download what it produced' }).getAttribute('href')).toBe('/api/artifacts/1/download');
  });
});

describe('needsOutcomePanel', () => {
  it('stays out of a clean success with results and appears for missing or stopped output', () => {
    expect(needsOutcomePanel(run(), list([artifact()]))).toBe(false);
    expect(needsOutcomePanel(run(), list([]))).toBe(true);
    expect(needsOutcomePanel(run({ status: 'failed', exitCode: 1 }), list([artifact()]))).toBe(true);
    expect(needsOutcomePanel(run({ limitBreached: 'memory' }), list([artifact()]))).toBe(true);
    expect(needsOutcomePanel(run({ status: 'running' }), undefined)).toBe(false);
  });
});
