import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationEvent } from '@automate/core';
import { ConversationView } from '../../../components/conversation/conversation-view';
afterEach(cleanup);
const at = '2026-09-22T00:00:00.000Z';
const events: ConversationEvent[] = [
  { seq: 7, type: 'state_changed', from: 'generating', to: 'completed', at },
  { seq: 1, type: 'user_prompt', text: 'Do it', at },
  { seq: 2, type: 'assistant_text', text: '**Working**', at },
  {
    seq: 3,
    type: 'tool_started',
    callId: 'a',
    tool: 'status',
    input: { ok: true },
    at,
  },
  {
    seq: 4,
    type: 'tool_finished',
    callId: 'a',
    tool: 'status',
    output: { value: '<b>text</b>' },
    isError: false,
    at,
  },
  { seq: 5, type: 'turn_finished', usage: { turns: 1 }, at },
  {
    seq: 6,
    type: 'failed',
    error: { code: 'SAFE', message: 'Readable failure' },
    at,
  },
];
describe('ConversationView', () => {
  it('renders all seven event kinds in seq order and tool details safely', async () => {
    const user = userEvent.setup();
    const { container } = render(<ConversationView events={events} />);
    expect(await screen.findByText('Working')).toBeTruthy();
    expect(container.textContent?.indexOf('Do it')).toBeLessThan(
      container.textContent?.indexOf('Working') ?? 0,
    );
    expect(screen.getByText('status — finished · 0 ms')).toBeTruthy();
    await user.click(screen.getByText('status — finished · 0 ms'));
    expect(screen.getByText(/<b>text<\/b>/)).toBeTruthy();
    expect(screen.getByText('Turn finished').textContent).not.toMatch(
      /token|\$/,
    );
    expect(screen.getByText('Readable failure')).toBeTruthy();
    expect(screen.getByText(/Status changed/)).toBeTruthy();
  });
  it('renders hostile markdown without executable DOM', async () => {
    const hostile: ConversationEvent = {
      seq: 1,
      type: 'assistant_text',
      text: '<script>alert(1)</script><img src=x onerror=alert(1)> [bad](javascript:alert(1))',
      at,
    };
    const { container } = render(<ConversationView events={[hostile]} />);
    await screen.findByLabelText('Assistant message');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(
      container.querySelector('a')?.getAttribute('href') ?? '',
    ).not.toMatch(/^javascript:/);
  });
  it('shows running tools, empty state, and jump-to-latest when unpinned', async () => {
    const { rerender } = render(<ConversationView events={[]} />);
    expect(screen.getByText(/conversation will appear/i)).toBeTruthy();
    rerender(
      <ConversationView
        events={[
          {
            seq: 1,
            type: 'tool_started',
            callId: 'x',
            tool: 'slow',
            input: {},
            at,
          },
        ]}
      />,
    );
    expect(screen.getByText('slow — running')).toBeTruthy();
    const viewport = screen.getByText('slow — running').closest('details')
      ?.parentElement as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 },
      scrollTop: { value: 0, writable: true },
    });
    fireEvent.scroll(viewport);
    expect(await screen.findByText('Jump to latest')).toBeTruthy();
  });
});
