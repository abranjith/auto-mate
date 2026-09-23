import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ds } from '../../design-system/tokens';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}
/** Render untrusted model markdown without enabling raw HTML. */
export function AssistantMessage({ text }: { text: string }) {
  return (
    <article className={ds.assistantMessage} aria-label="Assistant message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}
