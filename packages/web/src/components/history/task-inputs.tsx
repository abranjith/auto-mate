import { formatBytes } from '@automate/core';
import { useTaskUploads } from '../../api/upload-mutations';
import { ProfilePanel } from '../ingestion/profile-panel';
import { ds } from '../../design-system/tokens';

/** Saved input files and their existing local profile views. */
export function TaskInputs({ taskId }: { taskId: number }) {
  const query = useTaskUploads(taskId);
  if (!query.data?.uploads.length) return null;
  return <section className={ds.card}><h2 className={ds.sectionTitle}>Input files</h2><ul className={ds.listPlain}>
    {query.data.uploads.map((item) => <li key={item.upload.id} className={ds.listItem}><details><summary className={ds.codeCardSummary}>{item.upload.originalFilename} · {formatBytes(item.upload.byteSize)} · {item.profiles.map((profile) => `${profile.rowCount.toLocaleString()} rows × ${profile.columnCount} columns`).join(', ')}</summary><ProfilePanel upload={item} /></details></li>)}
  </ul></section>;
}
