import type { ReactNode } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ds } from '../../design-system/tokens';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/**
 * THE markdown policy for untrusted text in this application: GitHub-flavoured
 * markdown, raw HTML never enabled (no raw-HTML rehype plugin), links opened with
 * `noopener noreferrer nofollow`. FEAT-109's markdown artifact renderer
 * imports this object rather than configuring its own, so there is one policy.
 */
export const MARKDOWN_OPTIONS: Readonly<Pick<Options, 'remarkPlugins' | 'components'>> = Object.freeze({
  remarkPlugins: [remarkGfm],
  components: {
    a: (props) => (
      <a {...props} target="_blank" rel="noopener noreferrer nofollow" />
    ),
    pre: ({ children }) => (
      <div>
        <button
          type="button"
          className={ds.btnGhost}
          onClick={() =>
            void navigator.clipboard?.writeText(textOf(children))
          }
        >
          Copy
        </button>
        <pre className={ds.codeBlock}>{children}</pre>
      </div>
    ),
  },
});

/** Render untrusted model markdown without enabling raw HTML. */
export function AssistantMessage({ text }: { text: string }) {
  return (
    <article className={ds.assistantMessage} aria-label="Assistant message">
      <ReactMarkdown {...MARKDOWN_OPTIONS}>{text}</ReactMarkdown>
    </article>
  );
}
