import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { AutoMateError } from '@automate/core';
import { useTaskHistory } from '../../api/history-queries';
import { ds } from '../../design-system/tokens';
import { HistoryFilters } from './history-filters';
import { HistoryItem } from './history-item';
import { NeedsYouStrip } from './needs-you-strip';

/** Searchable, paged task history with a separate needs-you strip. */
export function HistoryList({ status: initialStatus = 'all', q: initialQuery = '' }: { status?: string; q?: string }) {
  const [status, setStatus] = useState(initialStatus); const [input, setInput] = useState(initialQuery); const [q, setQ] = useState(initialQuery);
  const [announcement] = useState(() => sessionStorage.getItem('automate:history-announcement') ?? '');
  useEffect(() => { sessionStorage.removeItem('automate:history-announcement'); }, []);
  const navigate = useNavigate();
  useEffect(() => { setStatus(initialStatus); setInput(initialQuery); setQ(initialQuery); }, [initialStatus, initialQuery]);
  useEffect(() => { const timer = setTimeout(() => { const term = input.trim(); setQ(term); void navigate({ to: '/history', search: { status, q: term }, replace: true }); }, 300); return () => clearTimeout(timer); }, [input, status, navigate]);
  const list = useTaskHistory(status, q); const parked = useTaskHistory('needs_you', '');
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const needsYou = parked.data?.pages.flatMap((page) => page.items) ?? [];
  const more = async () => { const next = items.length; await list.fetchNextPage(); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-history-index="${next}"] a`)?.focus()); };
  return <div className={ds.cardStack}>
    <p role="status" aria-live="polite" className={ds.srOnly}>{announcement}</p>
    <NeedsYouStrip items={needsYou} />
    <section className={ds.card}><h1 className={ds.sectionTitle}>History</h1><HistoryFilters status={status} q={input} onStatus={(value) => { setStatus(value); void navigate({ to: '/history', search: { status: value, q }, replace: true }); }} onQuery={setInput} />
      {list.isPending ? <p className={ds.statusMuted}>Loading history…</p> : list.isError ? <p className={ds.statusDanger}>History could not be loaded. {list.error instanceof AutoMateError && list.error.correlationId ? `Reference: ${list.error.correlationId}.` : ''} <button className={ds.btnGhost} onClick={() => void list.refetch()}>Try again</button></p> : items.length === 0 ? <p className={ds.hint}>{q || status !== 'all' ? <>No tasks match. <button className={ds.btnGhost} onClick={() => { setInput(''); setQ(''); setStatus('all'); void navigate({ to: '/history', search: {} }); }}>Clear filters</button></> : <>Nothing here yet. <Link to="/" className={ds.historyLink}>New task</Link></>}</p> : <ul className={ds.historyList}>{items.map((item, index) => <HistoryItem key={item.task.id} item={item} index={index} />)}</ul>}
      {list.hasNextPage ? <button className={ds.btnGhost} disabled={list.isFetchingNextPage} onClick={() => void more()}>Load more</button> : null}
    </section>
  </div>;
}
