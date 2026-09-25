import { useState } from 'react';
import { shortDigest, type CodeVersionDetail, type ConversationEvent } from '@automate/core';
import { getCodeVersion } from '../../api/generation-queries';
import { ds } from '../../design-system/tokens';
import { CodeFileView } from './code-file-view';

type Sealed = Extract<ConversationEvent, { type: 'code_version_sealed' }>;

/**
 * One attempt's code: its files, line counts, and short digest, collapsed by
 * default and one click from open. The content is fetched only when opened;
 * the transcript event never carries code.
 */
export function CodeVersionCard({ event, load = getCodeVersion }: { event: Sealed; load?: (id: number) => Promise<CodeVersionDetail> }) {
  const [detail, setDetail] = useState<CodeVersionDetail>();
  const [error, setError] = useState<string>();
  const open = async () => {
    if (detail) return;
    try { setDetail(await load(event.codeVersionId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The code could not be loaded.'); }
  };
  const verdict = detail?.testsPassed === true ? <span className={ds.attemptPassed}>tests passed</span> : detail?.testsPassed === false ? <span className={ds.attemptFailed}>tests failed</span> : null;
  const lines = event.files.reduce((sum, { lineCount }) => sum + lineCount, 0);
  return (
    <details className={ds.codeCard} onToggle={(toggle) => { if (toggle.currentTarget.open) void open(); }}>
      <summary className={ds.codeCardSummary}>
        <span>Attempt {event.attempt} — {event.files.length} file{event.files.length === 1 ? '' : 's'}, {lines} lines</span>
        <span className={ds.digest} title={event.digest}>{shortDigest(event.digest)}</span>
        {verdict}
      </summary>
      <ul className={ds.codeFileList}>
        {event.files.map((file) => <li key={file.path}><code className={ds.inlineCode}>{file.path}</code> <span className={ds.hint}>{file.lineCount} lines · {file.role}</span></li>)}
      </ul>
      {error ? <p className={ds.statusDanger} role="alert">{error}</p> : null}
      {detail ? detail.files.map((file) => <CodeFileView key={file.path} file={file} />) : error ? null : <p className={ds.hint}>Loading the code…</p>}
    </details>
  );
}
