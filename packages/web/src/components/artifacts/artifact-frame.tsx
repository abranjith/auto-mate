// ---------------------------------------------------------------------------
// Where generated HTML (and PDF) renders (FEAT-109 TASK-008, D12).
//
// Nothing mounts until the person clicks Show preview; until then the file's
// name, size, and `describeArtifactSafety` are shown, verbatim. On click an
// <iframe> mounts with `sandbox={SANDBOX_ATTRIBUTE}` — scripts and nothing
// else: no same-origin token, no popups, no forms, no top navigation — over
// `/content`, whose response carries `ARTIFACT_CSP`. The document lands in an
// opaque origin with no access to this application's DOM, storage, or
// cookies, and with no network destination it could send anything to.
//
// That is a guarantee about the BROWSER only. The Python that wrote the report
// ran unisolated with this application's access (D03).
//
// The sandbox value comes from the shared constant and is never typed here; a
// source scan keeps the same-origin token out of this package entirely. No
// injected markup of any kind: the bytes never pass through this page's DOM.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { SANDBOX_ATTRIBUTE, describeArtifactSafety, formatBytes, type ArtifactView } from '@automate/core';
import { artifactContentUrl } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';
import { DownloadLink } from './download-controls';

/** How long a PDF frame may take to report a load before the download prompt replaces it. */
export const PDF_LOAD_TIMEOUT_MS = 4_000;

/** The sandboxed preview for `sandboxed_html` and `sandboxed_pdf` artifacts, behind an explicit click. */
export function ArtifactFrame({ artifact, loadTimeoutMs = PDF_LOAD_TIMEOUT_MS }: { artifact: ArtifactView; loadTimeoutMs?: number }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const isPdf = artifact.renderMode === 'sandboxed_pdf';
  useEffect(() => {
    if (!open || !isPdf || loaded) return;
    const timer = setTimeout(() => setGaveUp(true), loadTimeoutMs);
    return () => clearTimeout(timer);
  }, [open, isPdf, loaded, loadTimeoutMs]);
  const close = () => { setOpen(false); setLoaded(false); setGaveUp(false); };
  return (
    <div className={ds.stackTight}>
      <ul className={ds.safetyNote} aria-label="About this preview">
        {describeArtifactSafety(artifact.renderMode).map((line) => <li key={line}>{line}</li>)}
      </ul>
      {!open ? (
        <div className={ds.row}>
          <button type="button" className={ds.btnGhost} onClick={() => setOpen(true)}>Show preview</button>
          <span className={ds.artifactMeta}>{formatBytes(artifact.byteSize)}</span>
        </div>
      ) : gaveUp ? (
        <div className={ds.row} role="status">
          <span>Your browser did not show this PDF inside the app. Download it to open it.</span>
          <DownloadLink artifact={artifact} />
          <button type="button" className={ds.btnSmall} onClick={close}>Close preview</button>
        </div>
      ) : (
        <div className={ds.stackTight}>
          <iframe
            title={`Preview of ${artifact.filename}`}
            className={ds.previewFrame}
            sandbox={SANDBOX_ATTRIBUTE}
            referrerPolicy="no-referrer"
            loading="lazy"
            src={artifactContentUrl(artifact.id)}
            onLoad={() => setLoaded(true)}
          />
          <div className={ds.row}>
            <button type="button" className={ds.btnSmall} onClick={close}>Close preview</button>
          </div>
        </div>
      )}
    </div>
  );
}
