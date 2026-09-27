// One output file (FEAT-109 TASK-007). Name, type, size, and the model-written
// title and description render as TEXT; an undeclared file says so. Every
// viewer is lazy-loaded; generated HTML and PDF go only through the sandboxed
// frame, which keeps its own explicit Show preview.

import { lazy, Suspense, useState } from 'react';
import { formatBytes, type ArtifactView } from '@automate/core';
import { ds } from '../../design-system/tokens';
import { UntrustedText } from '../verification/run-intent-panel';
import { DownloadLink } from './download-controls';

const ArtifactFrame = lazy(() => import('./artifact-frame').then((module) => ({ default: module.ArtifactFrame })));
const ArtifactTable = lazy(() => import('./artifact-table').then((module) => ({ default: module.ArtifactTable })));
const ArtifactImage = lazy(() => import('./artifact-image').then((module) => ({ default: module.ArtifactImage })));
const ArtifactMarkdown = lazy(() => import('./artifact-markdown').then((module) => ({ default: module.ArtifactMarkdown })));
const ArtifactText = lazy(() => import('./artifact-text').then((module) => ({ default: module.ArtifactText })));

/** The sentence under an undeclared file. */
export const UNDECLARED_SENTENCE = 'The script wrote this but did not list it.';

/** The right viewer for a render mode; the sandboxed ones gate themselves. */
function Viewer({ artifact }: { artifact: ArtifactView }) {
  switch (artifact.renderMode) {
    case 'sandboxed_html':
    case 'sandboxed_pdf': return <ArtifactFrame artifact={artifact} />;
    case 'table': return <ArtifactTable artifact={artifact} />;
    case 'image': return <ArtifactImage artifact={artifact} />;
    case 'markdown': return <ArtifactMarkdown artifact={artifact} />;
    case 'text': return <ArtifactText artifact={artifact} />;
    case 'download_only': return <p className={ds.hint}>This file is not shown in the app. Download it to open it.</p>;
  }
}

export function ArtifactCard({ artifact }: { artifact: ArtifactView }) {
  const sandboxed = artifact.renderMode === 'sandboxed_html' || artifact.renderMode === 'sandboxed_pdf';
  const [showing, setShowing] = useState(false);
  return (
    <li className={ds.artifactCard}>
      <div className={ds.artifactCardHeader}>
        <span className={ds.artifactName}><UntrustedText value={artifact.filename} /></span>
        <span className={ds.row}>
          <span className={ds.artifactMeta}>{artifact.type} · {formatBytes(artifact.byteSize)}</span>
          {!artifact.declared ? <span className={ds.badgeUndeclared}>Not listed</span> : null}
          <DownloadLink artifact={artifact} />
        </span>
      </div>
      {!artifact.declared ? <p className={ds.hint}>{UNDECLARED_SENTENCE}</p> : null}
      {artifact.title && artifact.title !== artifact.filename ? <p><UntrustedText value={artifact.title} /></p> : null}
      {artifact.description ? <p className={ds.hint}><UntrustedText value={artifact.description} /></p> : null}
      {sandboxed || showing ? (
        <Suspense fallback={<p className={ds.statusMuted}>Loading the viewer…</p>}>
          <Viewer artifact={artifact} />
        </Suspense>
      ) : null}
      {!sandboxed ? (
        <div className={ds.row}>
          <button type="button" className={ds.btnSmall} aria-expanded={showing} onClick={() => setShowing(!showing)}>{showing ? 'Hide preview' : 'Show preview'}</button>
        </div>
      ) : null}
    </li>
  );
}
