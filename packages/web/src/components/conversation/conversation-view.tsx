import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationEvent } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { ToolCallCard } from './tool-call-card';
import { TurnSummary } from './turn-summary';
import { ClarificationEvent } from './clarification-event';
import { DisclosureReceipt } from '../disclosure/disclosure-receipt';
import { CodeVersionCard } from '../generation/code-version-card';
import { TestRunEvent } from '../generation/test-run-event';
const AssistantMessage = lazy(() =>
  import('./assistant-message').then((module) => ({
    default: module.AssistantMessage,
  })),
);
type ToolFinished = Extract<ConversationEvent, { type: 'tool_finished' }>;
function assertNever(value: never): never {
  throw new Error(`Unknown conversation event: ${JSON.stringify(value)}`);
}

/** Ordered, exhaustive rendering of the durable transcript. */
export function ConversationView({
  events,
  executionId,
}: {
  events: readonly ConversationEvent[];
  executionId?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const ordered = useMemo(
    () => [...events].sort((a, b) => a.seq - b.seq),
    [events],
  );
  const finishes = useMemo(
    () =>
      new Map(
        ordered
          .filter(
            (event): event is ToolFinished => event.type === 'tool_finished',
          )
          .map((event) => [event.callId, event]),
      ),
    [ordered],
  );
  const starts = useMemo(
    () =>
      new Set(
        ordered
          .filter((event) => event.type === 'tool_started')
          .map((event) => event.callId),
      ),
    [ordered],
  );
  useEffect(() => {
    if (pinned && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [ordered.length, pinned]);
  const scroll = () => {
    const node = viewport.current;
    if (node)
      setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
  };
  const latest = () => {
    const node = viewport.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      setPinned(true);
    }
  };
  if (!ordered.length)
    return (
      <div className={ds.card}>
        The conversation will appear here when the run starts.
      </div>
    );
  return (
    <div>
      <div ref={viewport} className={ds.conversation} onScroll={scroll}>
        {ordered.map((event) => {
          switch (event.type) {
            case 'user_prompt':
              return (
                <p key={event.seq} className={ds.userMessage}>
                  {event.text}
                </p>
              );
            case 'assistant_text':
              return (
                <Suspense
                  key={event.seq}
                  fallback={<p className={ds.eventLine}>Rendering response…</p>}
                >
                  <AssistantMessage text={event.text} />
                </Suspense>
              );
            case 'tool_started':
              return (
                <ToolCallCard
                  key={event.seq}
                  started={event}
                  finished={finishes.get(event.callId)}
                />
              );
            case 'tool_finished':
              return starts.has(event.callId) ? null : (
                <ToolCallCard key={event.seq} finished={event} />
              );
            case 'turn_finished':
              return <TurnSummary key={event.seq} event={event} />;
            case 'failed':
              return (
                <p key={event.seq} className={ds.statusDanger}>
                  {event.error.message}
                </p>
              );
            case 'state_changed':
              return (
                <p key={event.seq} className={ds.eventLine}>
                  Status changed from {event.from} to {event.to}.
                </p>
              );
            case 'clarification_requested':
              return executionId ? <ClarificationEvent key={event.seq} executionId={executionId} clarificationId={event.clarificationId} /> : <p key={event.seq} className={ds.eventLine}>Clarification requested.</p>;
            case 'clarification_answered':
              return <p key={event.seq} className={ds.eventLine}>Clarification answered.</p>;
            case 'disclosure_sent':
              return executionId ? <DisclosureReceipt key={event.seq} executionId={executionId} event={event} /> : <p key={event.seq} className={ds.eventLine}>Disclosure sent to {event.provider} {event.model}.</p>;
            case 'code_version_sealed':
              return <CodeVersionCard key={event.seq} event={event} />;
            case 'test_run_finished':
              return <TestRunEvent key={event.seq} event={event} {...(executionId ? { executionId } : {})} />;
            case 'generation_settled':
              return <p key={event.seq} className={ds.generationSettled}>{event.summary}</p>;
            default:
              return assertNever(event);
          }
        })}
      </div>
      {!pinned ? (
        <button type="button" className={ds.btnGhost} onClick={latest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
