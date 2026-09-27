import { describeNeedsYou, type TaskHistoryItem } from '@automate/core';
import { Link } from '@tanstack/react-router';
import { ds } from '../../design-system/tokens';

/** Pending decisions stay visible above the paged list. */
export function NeedsYouStrip({ items }: { items: readonly TaskHistoryItem[] }) {
  if (items.length === 0) return null;
  return <section className={ds.needsYouStrip}><h2 className={ds.sectionTitle}>Needs you</h2><ul className={ds.listPlain}>{items.map((item) => <li className={ds.historyItem} key={item.task.id}><Link className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(item.task.id), executionId: String(item.latestRun.id) }}>{item.task.name} · {describeNeedsYou(item.latestRun.status as 'waiting' | 'awaiting_approval' | 'awaiting_review')}</Link><p className={ds.historyMeta}>Waiting since {new Date(item.latestRun.statusSince ?? item.latestRun.createdAt).toLocaleString()}</p></li>)}</ul></section>;
}
