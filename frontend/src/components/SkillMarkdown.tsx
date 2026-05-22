import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ComponentProps } from 'react';

/**
 * Render Markdown content (such as a SKILL.md body) with GFM extensions.
 *
 * We intentionally avoid the @tailwindcss/typography plugin to keep deps
 * small and apply targeted styles via the `components` prop and a wrapping
 * scoped CSS class.
 */
export function SkillMarkdown({ children }: { children: string }) {
  return (
    <div className="skill-md text-sm text-slate-800 leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 className="text-xl font-semibold mt-6 mb-3 first:mt-0" {...withoutNode(p)} />,
          h2: (p) => <h2 className="text-lg font-semibold mt-5 mb-2 first:mt-0" {...withoutNode(p)} />,
          h3: (p) => <h3 className="text-base font-semibold mt-4 mb-2 first:mt-0" {...withoutNode(p)} />,
          h4: (p) => <h4 className="text-sm font-semibold mt-3 mb-1.5 first:mt-0" {...withoutNode(p)} />,
          p: (p) => <p className="my-2" {...withoutNode(p)} />,
          ul: (p) => <ul className="list-disc pl-6 my-2 space-y-1" {...withoutNode(p)} />,
          ol: (p) => <ol className="list-decimal pl-6 my-2 space-y-1" {...withoutNode(p)} />,
          li: (p) => <li {...withoutNode(p)} />,
          a: (p) => (
            <a
              {...withoutNode(p)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 hover:underline"
            />
          ),
          code: ({ node: _node, className, children, ...rest }) => {
            const isBlock = /\bhljs\b|\blanguage-/.test(className || '');
            if (isBlock) {
              return (
                <code
                  className={`block p-3 rounded-md bg-slate-900 text-slate-100 text-xs overflow-x-auto font-mono ${className || ''}`}
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="px-1 py-0.5 rounded bg-slate-100 text-slate-800 text-[0.85em] font-mono"
                {...rest}
              >
                {children}
              </code>
            );
          },
          pre: (p) => <pre className="my-3" {...withoutNode(p)} />,
          blockquote: (p) => (
            <blockquote className="border-l-4 border-slate-200 pl-3 my-3 text-slate-600" {...withoutNode(p)} />
          ),
          hr: (p) => <hr className="my-4 border-slate-200" {...withoutNode(p)} />,
          table: (p) => (
            <div className="my-3 overflow-x-auto">
              <table className="text-xs border-collapse" {...withoutNode(p)} />
            </div>
          ),
          th: (p) => <th className="border border-slate-200 px-2 py-1 bg-slate-50 text-left" {...withoutNode(p)} />,
          td: (p) => <td className="border border-slate-200 px-2 py-1" {...withoutNode(p)} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// react-markdown attaches an internal `node` prop we don't want to forward to DOM
function withoutNode<T extends { node?: unknown }>(p: T): Omit<T, 'node'> {
  const { node: _omit, ...rest } = p;
  return rest;
}

// Suppress unused-warning when rendering raw node props
export type _MarkdownProps = ComponentProps<typeof ReactMarkdown>;
