import type { ArtifactListResponse } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { ArtifactCard } from './artifact-card';
import { DownloadAll } from './download-controls';

/**
 * A run's outputs (FEAT-109 TASK-007): any difference between what was
 * declared, written, and kept — in words — then Download all, then one card
 * per file.
 */
export function ArtifactList({ list }: { list: ArtifactListResponse }) {
  return (
    <section className={ds.stackTight} aria-label="What it produced">
      <h3 className={ds.label}>What it produced</h3>
      {list.discrepancies.map((entry) => <p key={entry.kind} className={ds.discrepancyLine}>{entry.message}</p>)}
      <DownloadAll executionId={list.executionId} count={list.artifacts.length} totalBytes={list.totalBytes} />
      {list.artifacts.length > 0 ? (
        <ul className={ds.artifactList}>
          {list.artifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
        </ul>
      ) : null}
    </section>
  );
}
