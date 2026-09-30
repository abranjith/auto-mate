import { formatDurationMs, type ExecutionSummary } from '@automate/core';
import type { ConnectionState } from '../../api/use-execution-stream';
import { ds } from '../../design-system/tokens';
import { ConnectionIndicator } from '../conversation/connection-indicator';
import { ExecutionStatusBadge } from '../conversation/execution-status-badge';

/** The run's state, reported duration and cost, and display preference. */
export function RunHeader({ runNumber, execution, connection, onRetryConnection, technical, onTechnicalChange }: { runNumber?: number; execution?: ExecutionSummary; connection: ConnectionState; onRetryConnection(): void; technical: boolean; onTechnicalChange(on: boolean): void }) {
  const usage = execution?.usage;
  const counts = [usage?.turns === undefined ? null : `${usage.turns} turns`, usage?.inputTokens === undefined ? null : `${usage.inputTokens} input tokens`, usage?.outputTokens === undefined ? null : `${usage.outputTokens} output tokens`].filter(Boolean);
  return <header className={ds.runHeader}>
    <div className={ds.header}><h2 className={ds.sectionTitle}>{runNumber === undefined ? 'Run' : `Run ${runNumber}`}</h2><div className={ds.row}>{execution ? <ExecutionStatusBadge status={execution.status} /> : null}<ConnectionIndicator state={connection} onRetry={onRetryConnection} /></div></div>
    {execution ? <p className={ds.runHeaderMeta}>{execution.durationMs === null ? 'Still running' : formatDurationMs(execution.durationMs)}{usage?.costUsd === undefined ? null : ` · Cost $${usage.costUsd.toFixed(4)}`}</p> : null}
    <label className={ds.techToggle}><input type="checkbox" role="switch" checked={technical} aria-checked={technical} onChange={(event) => onTechnicalChange(event.target.checked)} />Show technical details</label>
    {technical && counts.length ? <p className={ds.runHeaderMeta}>{counts.join(' · ')}</p> : null}
  </header>;
}
