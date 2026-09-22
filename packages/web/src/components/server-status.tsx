import { useHealth } from '../api/health-query';
import { ds } from '../design-system/tokens';

/** Show server status. @returns Connected, degraded, or unreachable text with a recovery hint. */
export function ServerStatus() {
  const { data, isError, isPending } = useHealth();
  if (isPending) return <span className={ds.statusMuted}>Checking server…</span>;
  if (isError || !data) return <span className={ds.statusDanger}>Server unreachable. Start it with pnpm dev.</span>;
  if (data.status === 'degraded') return <span className={ds.statusDanger}>Server degraded. Check the database and server log.</span>;
  return <span className={ds.statusSuccess}>Server connected · schema {data.database.schemaVersion}</span>;
}
