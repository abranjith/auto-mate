import type { ConnectionState } from '../../api/use-execution-stream';
import { ds } from '../../design-system/tokens';
const labels: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Finished',
  offline: 'Offline',
};
/** Plain-language stream health with an explicit retry affordance. */
export function ConnectionIndicator({
  state,
  onRetry,
}: {
  state: ConnectionState;
  onRetry(): void;
}) {
  return (
    <span
      className={
        state === 'live'
          ? ds.statusSuccess
          : state === 'closed'
            ? ds.statusMuted
            : ds.statusDanger
      }
    >
      {labels[state]}
      {state === 'reconnecting' || state === 'offline' ? (
        <button type="button" className={ds.btnGhost} onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </span>
  );
}
