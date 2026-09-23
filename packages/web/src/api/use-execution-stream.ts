import { Value } from '@sinclair/typebox/value';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ServerToClientMessageSchema,
  executionSocketPath,
  isTerminal,
  type ConversationEvent,
  type ExecutionSummary,
  type ServerToClientMessage,
} from '@automate/core';
import { getConversationEvents, getExecution } from './task-queries';
export type ConnectionState =
  'connecting' | 'live' | 'reconnecting' | 'closed' | 'offline';
export interface ExecutionStream {
  events: readonly ConversationEvent[];
  execution: ExecutionSummary | undefined;
  connection: ConnectionState;
  error?: string;
  retry(): void;
}

export function mergeContiguousEvents(
  current: readonly ConversationEvent[],
  incoming: readonly ConversationEvent[],
): { events: ConversationEvent[]; gap: boolean } {
  const merged = [...current];
  let last = merged.at(-1)?.seq ?? 0;
  for (const event of [...incoming].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= last) continue;
    if (event.seq !== last + 1) return { events: merged, gap: true };
    merged.push(event);
    last = event.seq;
  }
  return { events: merged, gap: false };
}
async function loadHistory(executionId: number): Promise<ConversationEvent[]> {
  const result: ConversationEvent[] = [];
  let cursor = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await getConversationEvents(executionId, cursor);
    result.push(...page.events);
    cursor = page.lastSeq;
    hasMore = page.hasMore;
  }
  return result;
}
function socketUrl(executionId: number, afterSeq: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${executionSocketPath(executionId, afterSeq)}`;
}

/** Combine REST-owned history with a resume-from-seq WebSocket tail. */
export function useExecutionStream(executionId: number): ExecutionStream {
  const history = useQuery({
    queryKey: ['execution-events', executionId],
    queryFn: () => loadHistory(executionId),
    retry: 1,
  });
  const summary = useQuery({
    queryKey: ['execution', executionId],
    queryFn: () => getExecution(executionId),
    retry: 1,
  });
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [execution, setExecution] = useState<ExecutionSummary>();
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string>();
  const lastSeq = useRef(0);
  const socket = useRef<WebSocket | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempts = useRef(0);
  const disposed = useRef(false);
  const openRef = useRef<() => void>(() => undefined);
  const executionRef = useRef<ExecutionSummary | undefined>(undefined);
  const refetchHistory = history.refetch;
  const updateExecution = (value: ExecutionSummary) => {
    executionRef.current = value;
    setExecution(value);
  };
  const merge = useCallback(
    (incoming: readonly ConversationEvent[]) => {
      setEvents((current) => {
        const next = mergeContiguousEvents(current, incoming);
        if (next.gap) {
          console.warn(
            'Conversation sequence gap detected; reloading history.',
          );
          void refetchHistory();
        } else lastSeq.current = next.events.at(-1)?.seq ?? 0;
        return next.events;
      });
    },
    [refetchHistory],
  );
  const reconnect = useCallback(
    (reload = false) => {
      if (disposed.current || !navigator.onLine) {
        setConnection('offline');
        return;
      }
      if (reload) void refetchHistory();
      const delay =
        Math.min(10_000, 500 * 2 ** attempts.current) *
        (0.8 + Math.random() * 0.4);
      attempts.current += 1;
      setConnection('reconnecting');
      timer.current = setTimeout(() => openRef.current(), delay);
    },
    [refetchHistory],
  );
  const open = useCallback(() => {
    if (disposed.current || history.data === undefined) return;
    if (!navigator.onLine) {
      setConnection('offline');
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    socket.current?.close();
    setConnection(attempts.current ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(socketUrl(executionId, lastSeq.current));
    socket.current = ws;
    ws.onopen = () => {
      attempts.current = 0;
      setConnection('live');
      setError(undefined);
    };
    ws.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Value.Check(ServerToClientMessageSchema, parsed)) return;
      const data = parsed as ServerToClientMessage;
      if (data.type === 'snapshot') {
        updateExecution(data.execution);
        merge(data.events);
      } else if (data.type === 'event') merge([data.event]);
      else {
        updateExecution(data.execution);
      }
    };
    ws.onclose = (event) => {
      if (disposed.current) return;
      if (event.code === 4004) {
        setError('Execution not found.');
        setConnection('closed');
        return;
      }
      const terminal =
        executionRef.current && isTerminal(executionRef.current.status);
      if (event.code === 1000 && terminal) {
        setConnection('closed');
        return;
      }
      reconnect(event.code === 1013);
    };
    ws.onerror = () => undefined;
  }, [executionId, history.data, merge, reconnect]);
  openRef.current = open;
  useEffect(() => {
    if (history.data) {
      const merged = mergeContiguousEvents([], history.data);
      setEvents(merged.events);
      lastSeq.current = merged.events.at(-1)?.seq ?? 0;
      open();
    }
  }, [history.data, open]);
  useEffect(() => {
    if (summary.data) updateExecution(summary.data);
  }, [summary.data]);
  useEffect(() => {
    const offline = () => {
      if (timer.current) clearTimeout(timer.current);
      socket.current?.close();
      setConnection('offline');
    };
    const online = () => reconnect(true);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [reconnect]);
  useEffect(
    () => () => {
      disposed.current = true;
      if (timer.current) clearTimeout(timer.current);
      socket.current?.close(1000);
    },
    [],
  );
  const retry = () => {
    attempts.current = 0;
    if (timer.current) clearTimeout(timer.current);
    openRef.current();
  };
  return { events, execution, connection, retry, ...(error ? { error } : {}) };
}
