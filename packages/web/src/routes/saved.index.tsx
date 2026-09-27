import { Link, createFileRoute } from '@tanstack/react-router';
import { useTemplates } from '../api/template-queries';
import { RelativeTime } from '../components/history/relative-time';
import { ds } from '../design-system/tokens';

function SavedTasks() {
  const query = useTemplates();
  if (query.isPending) return <p className={ds.statusMuted}>Loading saved tasks…</p>;
  if (query.isError) return <p className={ds.statusDanger}>Saved tasks could not be loaded.</p>;
  const items = query.data.pages.flatMap((page) => page.items);
  return <main className={ds.cardStack}><h1 className={ds.title}>Saved tasks</h1>
    {items.length === 0 ? <p>No saved tasks yet. When a run does what you wanted, choose Save this task.</p> : <ul className={ds.savedList}>{items.map((item) => <li key={item.id} className={ds.savedItem}>
      <Link to="/saved/$templateId" params={{ templateId: String(item.id) }} className={ds.historyLink}>{item.name}</Link>
      <p className={ds.hint}>Revision {item.currentRevisionNumber} · {item.lastRunAt ? <>last run <RelativeTime at={item.lastRunAt} /></> : 'never run'} · {item.runCount} {item.runCount === 1 ? 'run' : 'runs'}</p>
      <Link to="/saved/$templateId/run" params={{ templateId: String(item.id) }} className={ds.historyLink}>Run with another file</Link>
    </li>)}</ul>}
    {query.hasNextPage ? <button type="button" className={ds.btnGhost} disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</button> : null}
  </main>;
}
export const Route = createFileRoute('/saved/')({ component: SavedTasks });
