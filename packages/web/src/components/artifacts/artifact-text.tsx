import { useEffect, useState } from 'react';
import { formatBytes, type ArtifactPreview, type ArtifactView } from '@automate/core';
import { getPreview } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';
import { DownloadLink } from './download-controls';

/** Load an artifact's text head once. */
export function usePreview(id: number, load: typeof getPreview): { preview?: ArtifactPreview; error?: string } {
  const [state, setState] = useState<{ preview?: ArtifactPreview; error?: string }>({});
  useEffect(() => {
    let live = true;
    load(id).then((preview) => { if (live) setState({ preview }); }, (cause: unknown) => { if (live) setState({ error: cause instanceof Error ? cause.message : 'This file could not be shown.' }); });
    return () => { live = false; };
  }, [id, load]);
  return state;
}

/** The truncation notice, above the text, with the way to get the rest. */
export function TruncationNotice({ artifact, preview }: { artifact: ArtifactView; preview: ArtifactPreview }) {
  if (!preview.truncated) return null;
  return (
    <p className={ds.row}>
      <span className={ds.hint}>Showing the first {formatBytes(preview.previewBytes)} of {formatBytes(preview.byteSize)}.</span>
      <DownloadLink artifact={artifact} label="Download the whole file" />
    </p>
  );
}

/** A text or JSON output: its head, as plain text in a capped block. Nothing in it is run. */
export function ArtifactText({ artifact, load = getPreview }: { artifact: ArtifactView; load?: typeof getPreview }) {
  const { preview, error } = usePreview(artifact.id, load);
  if (error) return <p className={ds.statusDanger} role="alert">{error}</p>;
  if (!preview) return <p className={ds.statusMuted}>Loading…</p>;
  return (
    <div className={ds.stackTight}>
      <TruncationNotice artifact={artifact} preview={preview} />
      <pre className={ds.artifactText}>{preview.text}</pre>
    </div>
  );
}
