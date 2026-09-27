import { useState } from 'react';
import type { ArtifactView } from '@automate/core';
import { artifactContentUrl } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';
import { DownloadLink } from './download-controls';

/** A png, jpeg, webp, or gif output (never svg), as a picture; a broken load becomes a sentence, not a broken icon. */
export function ArtifactImage({ artifact }: { artifact: ArtifactView }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className={ds.row} role="status">
        <span>This picture could not be shown here.</span>
        <DownloadLink artifact={artifact} />
      </p>
    );
  }
  return <img className={ds.artifactImage} src={artifactContentUrl(artifact.id)} alt={artifact.title ?? artifact.filename} loading="lazy" onError={() => setFailed(true)} />;
}
