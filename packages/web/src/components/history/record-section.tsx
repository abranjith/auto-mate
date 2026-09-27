import { lazy, Suspense, useState } from 'react';
import { ds } from '../../design-system/tokens';

const Detail = lazy(() => import('./record-detail').then((module) => ({ default: module.RecordDetail })));
export type DetailKind = 'disclosure' | 'questions' | 'code' | 'checks' | 'run' | 'outputs';

/** A one-line summary; owning components load only when it is first opened. */
export function RecordSection({ title, summary, executionId, detail, resourceId, savedRevisionNumber }: { title: string; summary: string; executionId: number; detail?: DetailKind; resourceId?: number; savedRevisionNumber?: number }) {
  const [opened, setOpened] = useState(false);
  if (!detail) return <div className={ds.recordSection}><strong>{title}</strong><span>{summary}</span></div>;
  return <details className={ds.recordSection} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary className={ds.codeCardSummary}><strong>{title}</strong><span>{summary}</span></summary>
    {detail && opened ? <Suspense fallback={<p className={ds.hint}>Loading details…</p>}><Detail kind={detail} executionId={executionId} resourceId={resourceId} {...(savedRevisionNumber === undefined ? {} : { savedRevisionNumber })} /></Suspense> : null}
  </details>;
}
