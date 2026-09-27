import { useRunTimeline } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';
import { RunTimelineItem } from './run-timeline-item';

/** All runs of a task, with older pages loaded on demand. */
export function RunTimeline({ taskId }: { taskId: number }) {
  const timeline = useRunTimeline(taskId); const items = timeline.data?.pages.flatMap((page) => page.items) ?? [];
  return <section className={ds.card}><h2 className={ds.sectionTitle}>Runs</h2>
    {timeline.isError ? <p className={ds.statusDanger}>The runs could not be loaded.</p> : null}
    <ol className={ds.listPlain}>{items.map((item) => <RunTimelineItem key={item.id} item={item} />)}</ol>
    {timeline.hasNextPage ? <button className={ds.btnGhost} onClick={() => void timeline.fetchNextPage()}>Show older runs</button> : null}
  </section>;
}
