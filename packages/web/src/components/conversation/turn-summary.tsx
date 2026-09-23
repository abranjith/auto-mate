import type { ConversationEvent } from '@automate/core';
import { ds } from '../../design-system/tokens';
type Turn = Extract<ConversationEvent, { type: 'turn_finished' }>;
/** Render only usage figures actually reported by the provider. */
export function TurnSummary({ event }: { event: Turn }) {
  const usage = event.usage;
  return (
    <p className={ds.eventLine}>
      Turn finished
      {usage.inputTokens === undefined
        ? ''
        : ` · ${usage.inputTokens} input tokens`}
      {usage.outputTokens === undefined
        ? ''
        : ` · ${usage.outputTokens} output tokens`}
      {usage.costUsd === undefined ? '' : ` · $${usage.costUsd.toFixed(4)}`}
    </p>
  );
}
