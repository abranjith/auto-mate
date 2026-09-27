import { createFileRoute } from '@tanstack/react-router';
import { HistoryList } from '../components/history/history-list';

/** Show the future history location. @returns A labelled placeholder panel. */
function History() { const search = Route.useSearch(); return <HistoryList status={search.status} q={search.q} />; }
export const Route = createFileRoute('/history')({ validateSearch: (value: Record<string, unknown>): { status?: string; q?: string } => ({ ...(typeof value.status === 'string' && ['all', 'needs_you', 'running', 'done', 'stopped'].includes(value.status) ? { status: value.status } : {}), ...(typeof value.q === 'string' ? { q: value.q.slice(0, 200) } : {}) }), component: History });
