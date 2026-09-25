"use client";

/**
 * The renderer for a help article body on the public dark frame.
 *
 * Not the in-app `Markdown` component: that one is sized for a summary inside a card (headings
 * the size of body text, links that open in a new tab). An article needs article typography and
 * links that stay in the tab, since most of them point at other help pages. Rendered on the
 * server as well, so the text is in the HTML a crawler fetches.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeText, isBlockCode } from "@/lib/client/markdownCode";

/** Drop react-markdown's `node` prop, which is not a DOM attribute. */
function dom<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props;
  void _node;
  return rest;
}

const LINK_CLASS = "font-medium text-white underline decoration-white/30 underline-offset-4 hover:decoration-white";

/** Render an article's Markdown with the public page typography. */
export default function HelpMarkdown({ children }: { children: string }) {
  return (
    <div className="text-[15px] leading-7 text-white/70">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h2 className="mt-12 text-2xl font-semibold tracking-tight text-white first:mt-0" {...dom(props)} />,
          h2: (props) => <h2 className="mt-12 text-2xl font-semibold tracking-tight text-white first:mt-0" {...dom(props)} />,
          h3: (props) => <h3 className="mt-8 text-lg font-semibold text-white first:mt-0" {...dom(props)} />,
          h4: (props) => <h4 className="mt-6 text-base font-semibold text-white first:mt-0" {...dom(props)} />,
          p: (props) => <p className="mt-4 first:mt-0" {...dom(props)} />,
          ul: (props) => <ul className="mt-4 list-disc space-y-2 pl-6 marker:text-white/40" {...dom(props)} />,
          ol: (props) => <ol className="mt-4 list-decimal space-y-2 pl-6 marker:text-white/40" {...dom(props)} />,
          li: (props) => <li className="pl-1" {...dom(props)} />,
          strong: (props) => <strong className="font-semibold text-white" {...dom(props)} />,
          em: (props) => <em className="text-white/80" {...dom(props)} />,
          hr: () => <hr className="my-10 border-white/10" />,
          blockquote: (props) => <blockquote className="mt-4 border-l border-white/20 pl-4 text-white/60" {...dom(props)} />,
          a: ({ href, node: _node, ...props }) => {
            void _node;
            const external = /^https?:\/\//.test(href ?? "") && !(href ?? "").startsWith("https://lnkdrp.com");
            return <a href={href} className={LINK_CLASS} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...props} />;
          },
          table: (props) => (
            <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-left text-[14px]" {...dom(props)} />
            </div>
          ),
          thead: (props) => <thead className="bg-white/[0.04] text-white" {...dom(props)} />,
          th: (props) => <th className="px-4 py-2 font-semibold" {...dom(props)} />,
          td: (props) => <td className="border-t border-white/10 px-4 py-2 align-top" {...dom(props)} />,
          code: (codeProps) => {
            const { className, children, node: _node, ...props } = codeProps as { className?: string; children?: unknown; node?: unknown };
            void _node;
            const text = codeText(children);
            const block = isBlockCode(className, text);
            if (block) {
              return (
                <pre className="mt-4 overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-4 text-[13px] leading-6 text-white/80">
                  <code className="font-mono" {...props}>
                    {text.replace(/\n$/, "")}
                  </code>
                </pre>
              );
            }
            return (
              <code className="rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[0.9em] text-white/90" {...props}>
                {text}
              </code>
            );
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
