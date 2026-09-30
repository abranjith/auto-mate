import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONVERSATION_EVENT_KINDS, type ConversationEvent } from '@automate/core';
import { ConversationView, describeStateChange, isTechnicalEvent, joinAssistantText } from '../../../components/conversation/conversation-view';
import { TechnicalDetailsContext } from '../../../components/history/use-technical-details';
// Warm the lazily loaded markdown renderer once, so `findBy*` below measures
// rendering, not the first transform of its module graph — which can exceed
// the 1 s query timeout when the full workspace suite loads the CPU.
beforeAll(() => import('../../../components/conversation/assistant-message'), 30_000);
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
  it('hides technical events while retaining the prompt, reply, and state', async () => {
    const { container } = render(<ConversationView events={events} />);
    await screen.findByText('Working');
    expect(container.textContent).toContain('Do it');
    expect(container.textContent).toContain('Run ended: Done');
    for (const hidden of ['status — finished', 'Turn finished', 'Readable failure']) expect(container.textContent).not.toContain(hidden);
    expect(isTechnicalEvent(events.find((event) => event.type === 'failed')!)).toBe(true);
    expect(isTechnicalEvent(events.find((event) => event.type === 'user_prompt')!)).toBe(false);
  });

  it('explains an all-technical transcript', () => {
    render(<ConversationView events={events.filter(isTechnicalEvent)} />);
    expect(screen.getByText(/Turn on technical details/)).toBeTruthy();
  });
  it('classifies every registered conversation event kind', () => {
    const technical = new Set(['tool_started', 'tool_finished', 'turn_finished', 'clarification_answered', 'runtime_prepared', 'failed']);
    for (const { kind } of CONVERSATION_EVENT_KINDS) expect(isTechnicalEvent({ type: kind } as ConversationEvent), kind).toBe(technical.has(kind));
  });
  it('renders all seven event kinds in seq order and tool details safely', async () => {
    const user = userEvent.setup();
    const { container } = render(<TechnicalDetailsContext.Provider value={true}><ConversationView events={events} /></TechnicalDetailsContext.Provider>);
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
    expect(screen.getByText('Run ended: Done')).toBeTruthy();
    expect(screen.queryByText(/Status changed/)).toBeNull();
  });
  it('shows one message for a reply that streamed in as several chunks', async () => {
    // The chunk boundaries recorded from a real run, which used to render as six separate bubbles.
    const chunks = ['Done. I created `main.py`, which:\n\n- Reads `1-sample-data.csv`\n- Sorts the rows', ' by Age\n- Creates an interactive scatter chart of Salary vs.', ' Age\n'];
    const streamed: ConversationEvent[] = chunks.map((text, index) => ({ seq: index + 2, type: 'assistant_text', text, at }));
    render(<ConversationView events={[{ seq: 1, type: 'user_prompt', text: 'Chart it', at }, ...streamed]} />);
    await screen.findByLabelText('Assistant message');
    expect(screen.getAllByLabelText('Assistant message')).toHaveLength(1);
    expect(screen.getByText('Sorts the rows by Age')).toBeTruthy();
  });
  it('keeps replies separated by another event as separate messages', () => {
    const split: ConversationEvent[] = [
      { seq: 1, type: 'assistant_text', text: 'First', at },
      { seq: 2, type: 'turn_finished', usage: { turns: 1 }, at },
      { seq: 3, type: 'assistant_text', text: 'Second', at },
    ];
    expect(joinAssistantText(split).map((event) => event.type)).toEqual(['assistant_text', 'turn_finished', 'assistant_text']);
    expect(joinAssistantText([])).toEqual([]);
    expect(joinAssistantText([split[0]!, { ...split[2]!, seq: 2 }])).toEqual([{ ...split[0]!, text: 'FirstSecond' }]);
  });
  it.each([
    ['generating', 'Writing code'],
    ['verifying', 'Checking the code'],
    ['awaiting_approval', 'Waiting for your go-ahead'],
    ['failed', "Run ended: Didn't finish"],
    ['completed', 'Run ended: Done'],
  ] as const)('describes a move to %s as "%s"', (to, text) => {
    expect(describeStateChange({ to })).toBe(text);
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
    const { rerender } = render(<TechnicalDetailsContext.Provider value={true}><ConversationView events={[]} /></TechnicalDetailsContext.Provider>);
    expect(screen.getByText(/conversation will appear/i)).toBeTruthy();
    rerender(
      <TechnicalDetailsContext.Provider value={true}><ConversationView
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
      /></TechnicalDetailsContext.Provider>,
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
