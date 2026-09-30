import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { describeLineageEdge, describeLineageOrigin, describeRunState, type RunTimelineItem } from '@automate/core';
import { useRunTimeline } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';
import { RelativeTime } from './relative-time';

/** A task's runs in chronological order, with the reason for each later run. */
export function LineageRail({ taskId, currentExecutionId }: { taskId: number; currentExecutionId?: number }) {
  const timeline = useRunTimeline(taskId);
  const items = [...(timeline.data?.pages.flatMap((page) => page.items) ?? [])].reverse();
  const currentId = currentExecutionId ?? items.at(-1)?.id;
  const origin = !timeline.hasNextPage ? describeLineageOrigin(items[0]?.reuse ?? null) : null;
  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => { currentRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' }); }, [currentId]);
  return <section className={ds.card}>
    {timeline.isError ? <p className={ds.statusDanger}>The runs could not be loaded.</p> : null}
    <ol aria-label="Runs of this task" className={ds.lineageRail}>
      {timeline.hasNextPage ? <li><button className={ds.btnGhost} onClick={() => void timeline.fetchNextPage()}>Show earlier runs</button></li> : null}
      {origin ? <li className={ds.lineageOrigin}>{items[0]?.reuse?.templateId ? <Link to="/saved/$templateId" params={{ templateId: String(items[0].reuse.templateId) }}>{origin}</Link> : origin}</li> : null}
      {items.map((item, index) => <RunNodes key={item.id} item={item} taskId={taskId} current={item.id === currentId} first={index === 0} currentRef={currentRef} />)}
    </ol>
  </section>;
}

function RunNodes({ item, taskId, current, first, currentRef }: { item: RunTimelineItem; taskId: number; current: boolean; first: boolean; currentRef: React.RefObject<HTMLLIElement | null> }) {
  const state = describeRunState({ status: item.status, errorCode: item.errorCode });
  const edge = describeLineageEdge(item);
  return <>
    {!first ? <li className={ds.lineageEdge}><span aria-hidden="true">→ </span>{edge.label}{edge.quote ? <> <span className={ds.lineageQuote}>“{edge.quote}”</span></> : null}</li> : null}
    <li ref={current ? currentRef : undefined} className={current ? ds.lineageNodeCurrent : ds.lineageNode}>
      <Link aria-current={current ? 'page' : undefined} className={ds.historyLink} to="/tasks/$taskId/runs/$executionId" params={{ taskId: String(taskId), executionId: String(item.id) }}>Run {item.runNumber}</Link>
      <span className={ds.statusMuted}>{state.label} · <RelativeTime at={item.createdAt} /></span>
      {item.savedAs.map((saved) => <Link key={`${saved.templateId}-${saved.revisionNumber}`} className={ds.lineageMarker} to="/saved/$templateId" params={{ templateId: String(saved.templateId) }}>Saved as {saved.name}{saved.revisionNumber > 1 ? ` (revision ${saved.revisionNumber})` : ''}</Link>)}
    </li>
  </>;
}
