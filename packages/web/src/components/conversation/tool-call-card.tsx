import type { ConversationEvent } from '@automate/core';
import { ds } from '../../design-system/tokens';
type Started = Extract<ConversationEvent, { type: 'tool_started' }>;
type Finished = Extract<ConversationEvent, { type: 'tool_finished' }>;
/** A tool argument the transcript elided (FEAT-106): the file was written, its bytes live elsewhere. */
function isElided(value: unknown): value is { elided: true; byteSize: number } {
  return typeof value === 'object' && value !== null && (value as { elided?: unknown }).elided === true && typeof (value as { byteSize?: unknown }).byteSize === 'number';
}
/** "wrote 4.1 KiB" for an elided argument. */
export function elidedLabel(byteSize: number): string {
  return byteSize < 1024 ? `wrote ${byteSize} bytes` : `wrote ${(byteSize / 1024).toFixed(1)} KiB`;
}
/** Replace elided arguments with their plain-English size before display. */
function presentInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, isElided(value) ? elidedLabel(value.byteSize) : value]));
}
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
          <pre className={ds.codeBlock}>{json(presentInput(started.input))}</pre>
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
