import type { Server } from 'node:http';
import {
  isTerminal,
  WS_CLOSE,
  type ConversationEvent,
  type ServerToClientMessage,
  type ExecutionStatus,
} from '@automate/core';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerConfig } from '../config/env';
import {
  presentExecution,
  type TaskSessionRegistry,
} from '../conversation/index';
import type { ConversationEventRepository } from '../db/repositories/conversation-event-repository';
import type { ExecutionRepository } from '../db/repositories/execution-repository';
import { isAllowedHost, isAllowedOrigin } from '../middleware/origin-guard';

export interface ExecutionSocketDependencies {
  executions: ExecutionRepository;
  events: ConversationEventRepository;
  registry: TaskSessionRegistry;
  config: ServerConfig;
  logger: Logger;
  heartbeatMs?: number;
  maxBufferedBytes?: number;
}
function send(
  socket: WebSocket,
  message: ServerToClientMessage,
  maxBufferedBytes: number,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > maxBufferedBytes) {
    socket.close(WS_CLOSE.TRY_AGAIN, 'Client fell behind; reload history.');
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}
function parseTarget(
  url: string | undefined,
): { executionId: number; afterSeq: number } | undefined {
  if (!url) return undefined;
  const parsed = new URL(url, 'http://localhost');
  const match = /^\/api\/ws\/executions\/(\d+)$/.exec(parsed.pathname);
  if (!match) return undefined;
  const executionId = Number(match[1]);
  const afterSeq = Number(parsed.searchParams.get('afterSeq') ?? 0);
  return Number.isSafeInteger(executionId) &&
    executionId > 0 &&
    Number.isSafeInteger(afterSeq) &&
    afterSeq >= 0
    ? { executionId, afterSeq }
    : undefined;
}

/** Attach resume-capable execution sockets to an existing HTTP server. */
export function attachExecutionSocket(
  server: Server,
  deps: ExecutionSocketDependencies,
): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const heartbeatMs = deps.heartbeatMs ?? 30_000;
  const maxBufferedBytes = deps.maxBufferedBytes ?? 1_048_576;
  const targets = new WeakMap<
    WebSocket,
    { executionId: number; afterSeq: number }
  >();
  const upgrade = (
    request: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    const target = parseTarget(request.url);
    if (!target) {
      socket.destroy();
      return;
    }
    if (
      !isAllowedOrigin(request.headers.origin, deps.config) ||
      !isAllowedHost(request.headers.host, deps.config)
    ) {
      deps.logger.warn(
        { origin: request.headers.origin },
        'websocket upgrade rejected',
      );
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      targets.set(ws, target);
      wss.emit('connection', ws, request);
    });
  };
  server.on('upgrade', upgrade);
  wss.on('connection', (socket: WebSocket) => {
    const supplied = targets.get(socket);
    if (!supplied) {
      socket.terminate();
      return;
    }
    const { executionId, afterSeq } = supplied;
    const row = deps.executions.getById(executionId);
    if (!row) {
      socket.close(WS_CLOSE.NOT_FOUND, 'Execution not found.');
      return;
    }
    const page = deps.events.listAfter(executionId, afterSeq, 500);
    send(
      socket,
      {
        type: 'snapshot',
        execution: presentExecution(row),
        events: page.events,
        lastSeq: page.lastSeq,
      },
      maxBufferedBytes,
    );
    let missedPongs = 0;
    socket.on('pong', () => {
      missedPongs = 0;
    });
    const heartbeat = setInterval(() => {
      missedPongs += 1;
      if (missedPongs >= 2) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, heartbeatMs);
    // Subscribe to the registry, not a session: the provider session ends at
    // `verifying`, but verification, approval, the run, and the review keep
    // publishing events to this execution (FEAT-107).
    const live = deps.registry.isLive(executionId);
    const unsubscribe = deps.registry.subscribe(executionId, (event: ConversationEvent) => {
      if (!send(socket, { type: 'event', event }, maxBufferedBytes)) return;
      if (event.type !== 'state_changed') return;
      const latest = deps.executions.getById(executionId);
      if (!latest) return;
      send(
        socket,
        { type: 'execution_updated', execution: presentExecution(latest) },
        maxBufferedBytes,
      );
      if (isTerminal(event.to as ExecutionStatus))
        socket.close(WS_CLOSE.NORMAL, 'Execution finished.');
    });
    socket.on('message', () =>
      deps.logger.debug({ executionId }, 'ignored websocket client message'),
    );
    socket.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      deps.logger.info({ executionId }, 'websocket disconnected');
    });
    deps.logger.info({ executionId }, 'websocket connected');
    if (!live && isTerminal(row.status as ExecutionStatus))
      socket.close(WS_CLOSE.NORMAL, 'Execution finished.');
  });
  return () => {
    server.off('upgrade', upgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
