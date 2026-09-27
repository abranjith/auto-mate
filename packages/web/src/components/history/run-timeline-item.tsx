import { Link, useLocation } from '@tanstack/react-router';
import { describeRunState, describeTrigger, type RunTimelineItem as Item } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { RelativeTime } from './relative-time';

/** One dated, addressable run. */
export function RunTimelineItem({ item }: { item: Item }) {
  const current = useLocation().pathname.endsWith(`/runs/${item.id}`);
  const state = describeRunState({ status: item.status, errorCode: item.errorCode });
  return <li className={current ? ds.timelineCurrent : ds.listItem}>
    <Link aria-current={current ? 'page' : undefined} className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(item.taskId), executionId: String(item.id) }}>{describeTrigger(item.trigger, { hasGuidance: item.hasGuidance, reuseKind: item.reuse?.kind })}</Link>
    <p className={ds.statusMuted}>{state.label} · <RelativeTime at={item.createdAt} /> · {item.durationMs === null ? 'Still open' : `${item.durationMs} ms`} · {item.outputCount} outputs</p>
  </li>;
}
