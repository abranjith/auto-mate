import { ds } from '../../design-system/tokens';
import type { AttachmentStatus } from './use-attachments';

/** Determinate progress while bytes move; indeterminate while the server analyzes them. */
export function UploadProgress({ status, loaded, total }: { status: AttachmentStatus; loaded: number; total: number }) {
  if (status === 'uploading') {
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    return (
      <div className={ds.stackTight}>
        <progress className={ds.progress} value={loaded} max={total > 0 ? total : 1} aria-label="Upload progress" />
        <span className={ds.statusMuted}>Uploading… {percent}%</span>
      </div>
    );
  }
  if (status === 'analyzing') {
    return (
      <div className={ds.stackTight}>
        <progress className={ds.progress} aria-label="Analyzing the file" />
        <span className={ds.statusMuted}>Analyzing on this computer…</span>
      </div>
    );
  }
  return null;
}
