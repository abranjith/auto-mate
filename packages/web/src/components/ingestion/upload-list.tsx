import { lazy, Suspense, useState } from 'react';
import { formatBytes } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { UploadProgress } from './upload-progress';
import type { Attachment } from './use-attachments';

// The profile preview can hold hundreds of columns; it loads only when needed.
const ProfilePanel = lazy(() => import('./profile-panel').then((module) => ({ default: module.ProfilePanel })));

const STATUS_LABEL: Record<Attachment['status'], string> = {
  uploading: 'Uploading',
  analyzing: 'Analyzing',
  ready: 'Ready',
  failed: 'Failed',
};

function AttachmentItem({ item, onRemove, onRetry }: { item: Attachment; onRemove: () => void; onRetry: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <li className={ds.fileItem}>
      <div className={ds.fileItemHeader}>
        <span className={ds.fileName}>{item.file.name}</span>
        <div className={ds.row}>
          <span className={ds.statusMuted}>
            {formatBytes(item.file.size)} · {STATUS_LABEL[item.status]}
          </span>
          {item.status === 'failed' ? (
            <button type="button" className={ds.btnSmall} onClick={onRetry}>
              Retry
            </button>
          ) : null}
          {item.status === 'ready' ? (
            <button type="button" className={ds.btnSmall} aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide details' : 'Show details'}
            </button>
          ) : null}
          <button type="button" className={ds.btnSmall} aria-label={`Remove ${item.file.name}`} onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      <UploadProgress status={item.status} loaded={item.loaded} total={item.total} />
      {item.status === 'failed' ? (
        <p className={ds.statusDanger} role="alert">
          {item.error}
        </p>
      ) : null}
      {item.status === 'ready' && item.result && open ? (
        <Suspense fallback={<p className={ds.statusMuted}>Loading details…</p>}>
          <ProfilePanel upload={item.result} />
        </Suspense>
      ) : null}
    </li>
  );
}

/** One row per attached file: name, size, state, and remove/retry controls. */
export function UploadList({ items, onRemove, onRetry }: { items: readonly Attachment[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className={ds.fileList} aria-label="Attached files">
      {items.map((item) => (
        <AttachmentItem key={item.key} item={item} onRemove={() => onRemove(item.key)} onRetry={() => onRetry(item.key)} />
      ))}
    </ul>
  );
}
