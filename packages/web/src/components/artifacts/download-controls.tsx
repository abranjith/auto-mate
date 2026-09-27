import { formatBytes, type ArtifactView } from '@automate/core';
import { artifactArchiveUrl, artifactDownloadUrl } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';

/** Download one artifact. The server names the file; the model-written name never reaches an attribute here. */
export function DownloadLink({ artifact, label = 'Download' }: { artifact: Pick<ArtifactView, 'id' | 'filename'>; label?: string }) {
  return (
    <a className={ds.downloadLink} href={artifactDownloadUrl(artifact.id)} download aria-label={`${label}: ${artifact.filename}`}>
      {label}
    </a>
  );
}

/**
 * Download every artifact of a run as one ZIP. Shown only for more than one
 * file, with the count and total size on the control so nobody starts a large
 * download blind.
 */
export function DownloadAll({ executionId, count, totalBytes }: { executionId: number; count: number; totalBytes: number }) {
  if (count <= 1) return null;
  return (
    <div className={ds.downloadAll}>
      <a className={ds.btnPrimary} href={artifactArchiveUrl(executionId)} download>
        Download all {count} files ({formatBytes(totalBytes)}) as a ZIP
      </a>
    </div>
  );
}
