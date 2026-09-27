import { useEffect } from 'react';
import type { UploadResponse } from '@automate/core';
import { FileDropZone } from '../ingestion/file-drop-zone';
import { UploadList } from '../ingestion/upload-list';
import { useAttachments } from '../ingestion/use-attachments';
import { ds } from '../../design-system/tokens';

/** One required file position; upload, analysis, removal, and retry use the task composer's controls. */
export function SlotComposer({ position, label, format, onChange }: { position: number; label: string; format: string; onChange: (upload: UploadResponse | null) => void }) {
  const attachments = useAttachments();
  const upload = attachments.items.find((item) => item.status === 'ready')?.result ?? null;
  useEffect(() => onChange(upload), [upload?.upload.id]);
  return <section className={ds.savedItem}><h3>File {position + 1} — was “{label}” ({format === 'xlsx' ? 'Excel workbook' : 'CSV'})</h3>
    {!attachments.items.length ? <FileDropZone existingCount={0} onAccept={(files) => attachments.add(files.slice(0, 1))} /> : null}
    <UploadList items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />
  </section>;
}
