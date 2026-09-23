import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationEvent, ExecutionSummary } from '@automate/core';
import {
  mergeContiguousEvents,
  useExecutionStream,
} from './use-execution-stream';
const mocks = vi.hoisted(() => ({ events: vi.fn(), execution: vi.fn() }));
vi.mock('./task-queries', () => ({
  getConversationEvents: mocks.events,
  getExecution: mocks.execution,
}));
class MockSocket {
  static instances: MockSocket[] = [];
  url: string;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }
}
const at = '2026-09-22T00:00:00.000Z';
const execution: ExecutionSummary = {
  id: 9,
  taskId: 3,
  status: 'generating',
  provider: null,
  model: null,
  usage: {},
  startedAt: null,
  completedAt: null,
  durationMs: null,
  error: null,
  createdAt: at,
};
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);
beforeEach(() => {
  MockSocket.instances = [];
  vi.stubGlobal('WebSocket', MockSocket);
  mocks.events.mockResolvedValue({
    events: [{ seq: 1, type: 'user_prompt', text: 'go', at }],
    lastSeq: 1,
    hasMore: false,
  });
  mocks.execution.mockResolvedValue(execution);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('useExecutionStream', () => {
  it('merges only contiguous new events and detects a gap', () => {
    const one: ConversationEvent = {
      seq: 1,
      type: 'user_prompt',
      text: 'a',
      at,
    };
    const two: ConversationEvent = {
      seq: 2,
      type: 'assistant_text',
      text: 'b',
      at,
    };
    expect(mergeContiguousEvents([one], [one, two])).toEqual({
      events: [one, two],
      gap: false,
    });
    expect(mergeContiguousEvents([one], [{ ...two, seq: 3 }])).toEqual({
      events: [one],
      gap: true,
    });
  });
  it('loads REST history before opening the socket at its last sequence', async () => {
    const { result, unmount } = renderHook(() => useExecutionStream(9), {
      wrapper,
    });
    await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    expect(MockSocket.instances[0]?.url).toContain('afterSeq=1');
    MockSocket.instances[0]?.onopen?.();
    await waitFor(() => expect(result.current.connection).toBe('live'));
    expect(result.current.events.map((event) => event.seq)).toEqual([1]);
    unmount();
    expect(MockSocket.instances[0]?.close).toHaveBeenCalled();
  });
  it('deduplicates a snapshot and appends its tail', async () => {
    const { result } = renderHook(() => useExecutionStream(9), { wrapper });
    await waitFor(() => expect(MockSocket.instances).toHaveLength(1));
    const next = { seq: 2, type: 'assistant_text', text: 'hello', at } as const;
    MockSocket.instances[0]?.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        execution,
        events: [{ seq: 1, type: 'user_prompt', text: 'go', at }, next],
        lastSeq: 2,
      }),
    });
    await waitFor(() =>
      expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]),
    );
  });
});
