import ReactMarkdown from 'react-markdown';
import type { ArtifactView } from '@automate/core';
import { getPreview } from '../../api/artifact-queries';
import { ds } from '../../design-system/tokens';
import { MARKDOWN_OPTIONS } from '../conversation/assistant-message';
import { TruncationNotice, usePreview } from './artifact-text';

/**
 * The markdown policy for artifacts IS FEAT-103's: imported, not re-configured,
 * so raw HTML stays disabled and links stay `noopener noreferrer nofollow` in
 * one place. Exported so a test can assert the identity.
 */
export const ARTIFACT_MARKDOWN_OPTIONS = MARKDOWN_OPTIONS;

/** A Markdown output, formatted without running anything. */
export function ArtifactMarkdown({ artifact, load = getPreview }: { artifact: ArtifactView; load?: typeof getPreview }) {
  const { preview, error } = usePreview(artifact.id, load);
  if (error) return <p className={ds.statusDanger} role="alert">{error}</p>;
  if (!preview) return <p className={ds.statusMuted}>Loading…</p>;
  return (
    <div className={ds.stackTight}>
      <TruncationNotice artifact={artifact} preview={preview} />
      <article className={ds.artifactMarkdown} aria-label={`Contents of ${artifact.filename}`}>
        <ReactMarkdown {...ARTIFACT_MARKDOWN_OPTIONS}>{preview.text}</ReactMarkdown>
      </article>
    </div>
  );
}
