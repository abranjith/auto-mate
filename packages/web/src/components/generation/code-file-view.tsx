import { useState } from 'react';
import type { CodeFile } from '@automate/core';
import { ds } from '../../design-system/tokens';

/**
 * One generated file as a plain, line-numbered block with a copy control.
 * Generated code is model output: it renders as text only, never as markup,
 * and has no syntax highlighting (FEAT-103 ships none; a TODO owns it).
 */
export function CodeFileView({ file, copy = (text: string) => navigator.clipboard?.writeText(text) }: { file: CodeFile; copy?: (text: string) => Promise<void> | undefined }) {
  const [copied, setCopied] = useState(false);
  const content = file.content ?? '';
  const lines = content === '' ? [] : content.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const onCopy = async () => { await copy(content); setCopied(true); };
  return (
    <figure className={ds.stackTight}>
      <figcaption className={ds.row}>
        <code className={ds.inlineCode}>{file.path}</code>
        <span className={ds.hint}>{file.lineCount} lines · {file.role}</span>
        <button type="button" className={ds.btnSmall} onClick={() => void onCopy()}>{copied ? 'Copied' : 'Copy'}</button>
      </figcaption>
      <pre className={ds.codeView} aria-label={`Contents of ${file.path}`}>
        {lines.map((line, index) => (
          <div key={index} className={ds.codeLine}><span className={ds.codeLineNumber} aria-hidden="true">{index + 1}</span>{line}</div>
        ))}
      </pre>
    </figure>
  );
}
