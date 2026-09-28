import { Link, useLocation } from '@tanstack/react-router';
import { describeRunState, describeTrigger, formatDurationMs, type RunTimelineItem as Item } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { RelativeTime } from './relative-time';

/** One dated, addressable run: "Run 2 · Tried again", then its state, age, duration, and outputs. */
export function RunTimelineItem({ item }: { item: Item }) {
  const current = useLocation().pathname.endsWith(`/runs/${item.id}`);
  const state = describeRunState({ status: item.status, errorCode: item.errorCode });
  const outputs = `${item.outputCount} output${item.outputCount === 1 ? '' : 's'}`;
  return <li className={current ? ds.timelineCurrent : ds.listItem}>
    <Link aria-current={current ? 'page' : undefined} className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(item.taskId), executionId: String(item.id) }}>Run {item.runNumber} · {describeTrigger(item.trigger, { hasGuidance: item.hasGuidance, reuseKind: item.reuse?.kind })}</Link>
    <p className={ds.statusMuted}>{state.label} · <RelativeTime at={item.createdAt} /> · {item.durationMs === null ? 'Still open' : formatDurationMs(item.durationMs)} · {outputs}</p>
  </li>;
}
