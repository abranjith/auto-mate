import type { ConversationEvent } from '@automate/core';
import { ds } from '../../design-system/tokens';
type Started = Extract<ConversationEvent, { type: 'tool_started' }>;
type Finished = Extract<ConversationEvent, { type: 'tool_finished' }>;
function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Unserializable value]';
  }
}
/** Collapsible, text-only rendering for one normalized tool invocation. */
export function ToolCallCard({
  started,
  finished,
}: {
  started?: Started;
  finished?: Finished;
}) {
  const name = started?.tool ?? finished?.tool ?? 'Unknown tool';
  const duration =
    started && finished
      ? Math.max(
          0,
          new Date(finished.at).getTime() - new Date(started.at).getTime(),
        )
      : undefined;
  return (
    <details
      className={`${ds.toolCard} ${finished?.isError ? ds.statusDanger : ''}`}
    >
      <summary>
        {name} —{' '}
        {finished ? (finished.isError ? 'failed' : 'finished') : 'running'}
        {duration === undefined ? '' : ` · ${duration} ms`}
      </summary>
      {started ? (
        <>
          <h4>Input</h4>
          <pre className={ds.codeBlock}>{json(started.input)}</pre>
        </>
      ) : null}
      {finished ? (
        <>
          <h4>Output</h4>
          <pre className={ds.codeBlock}>{json(finished.output)}</pre>
        </>
      ) : null}
    </details>
  );
}
