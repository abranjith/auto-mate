import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExecutionSummary } from '@automate/core';
import { RunHeader } from '../../../components/history/run-header';

const execution: ExecutionSummary = { id: 9, taskId: 3, status: 'completed', trigger: 'manual', retryOfExecutionId: null, provider: null, model: null, usage: { costUsd: 0.0123, turns: 2, inputTokens: 12, outputTokens: 4 }, startedAt: null, completedAt: null, durationMs: 192000, error: null, createdAt: '2026-09-26T10:00:00.000Z' };
afterEach(cleanup);
describe('run header', () => {
  it('shows reported cost and duration, with token counts behind the switch', async () => {
    const user = userEvent.setup();
    const view = render(<RunHeader runNumber={2} execution={execution} connection="closed" onRetryConnection={() => undefined} technical={false} onTechnicalChange={(on) => view.rerender(<RunHeader runNumber={2} execution={execution} connection="closed" onRetryConnection={() => undefined} technical={on} onTechnicalChange={() => undefined} />)} />);
    expect(view.container.textContent).toContain('3 minutes 12 seconds');
    expect(view.container.textContent).toContain('Cost $0.0123');
    expect(view.container.textContent).not.toContain('input tokens');
    const toggle = screen.getByRole('switch', { name: 'Show technical details' });
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(view.container.textContent).toContain('12 input tokens');
  });

  it('omits cost when it was not reported', () => {
    const view = render(<RunHeader execution={{ ...execution, usage: {} }} connection="closed" onRetryConnection={() => undefined} technical={false} onTechnicalChange={() => undefined} />);
    expect(view.container.textContent).not.toContain('Cost $');
  });
});
