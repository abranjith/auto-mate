import { Link } from '@tanstack/react-router';
import { describeRunState, describeTrigger, type TaskHistoryItem } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { RelativeTime } from './relative-time';

/** One task in History, labelled by its most recent run. */
export function HistoryItem({ item, index }: { item: TaskHistoryItem; index?: number }) {
  const wording = describeRunState({ status: item.latestRun.status, errorCode: item.latestRun.errorCode });
  return <li className={ds.historyItem} data-history-index={index}>
    <Link to="/tasks/$taskId" params={{ taskId: String(item.task.id) }} className={ds.historyLink}>{item.task.name}</Link>
    <p className={ds.historyMeta}><span className={ds.badge}>{wording.label}</span> · <RelativeTime at={item.latestRun.createdAt} /></p>
    {item.latestRun.trigger !== 'manual' || item.latestRun.reuse ? <p className={ds.hint}>{describeTrigger(item.latestRun.trigger, { hasGuidance: false, reuseKind: item.latestRun.reuse?.kind })}</p> : null}
    <p className={ds.hint}>{item.runCount} {item.runCount === 1 ? 'run' : 'runs'} · {item.inputCount} {item.inputCount === 1 ? 'input' : 'inputs'} · {item.latestOutputCount} {item.latestOutputCount === 1 ? 'output' : 'outputs'} in the latest run</p>
  </li>;
}
