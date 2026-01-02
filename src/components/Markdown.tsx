"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Tone = "light" | "dark";
/**
 * Normalize Markdown Text (uses isArray, join, map).
 */


function normalizeMarkdownText(children: unknown) {
  // react-markdown passes code contents as `children: [string]` in most cases
  if (Array.isArray(children)) return children.map((c) => String(c)).join("");
  return String(children ?? "");
}
/**
 * Render the DiffBlock UI.
 */


function DiffBlock({
  text,
  tone = "light",
}: {
  text: string;
  tone?: Tone;
}) {
  const lines = text.replace(/\n$/, "").split("\n");

  // Use theme variables so Markdown automatically adapts to light/dark without
  // needing a `tone` prop at callsites.
  const baseText = "text-[var(--fg)]";
  const mutedText = "text-[var(--muted-2)]";
/**
 * Line Class (uses startsWith).
 */


  const lineClass = (line: string) => {
    void tone; // kept for backwards-compat signature; visual styling is theme-driven now.
    if (line.startsWith("@@")) return "bg-[var(--diff-hunk-bg)]";
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return "bg-[var(--diff-hunk-bg)]";
    if (line.startsWith("+")) return "bg-[var(--diff-add-bg)]";
    if (line.startsWith("-")) return "bg-[var(--diff-del-bg)]";
    return "";
  };
/**
 * Line Text Class (uses startsWith).
 */


  const lineTextClass = (line: string) => {
    if (line.startsWith("@@")) return mutedText;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return mutedText;
    return baseText;
  };

  return (
    <div
      className={[
        "overflow-hidden rounded-xl border",
        "border-[var(--code-border)] bg-[var(--code-bg)]",
      ].join(" ")}
    >
      <div className="overflow-auto">
        <pre className="m-0 p-3 text-[12px] leading-5">
          <code className="font-mono">
            {lines.map((line, idx) => (
              <div
                // eslint-disable-next-line react/no-array-index-key
                key={idx}
                className={[
                  "px-2 -mx-2",
                  lineClass(line),
                  lineTextClass(line),
                ].join(" ")}
                style={{ whiteSpace: "pre" }}
              >
                {line || " "}
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
/**
 * Render the Markdown UI.
 */


export default function Markdown({
  children,
  tone = "light",
  className,
}: {
  children: string;
  tone?: Tone;
  className?: string;
}) {
  void tone; // kept for backwards-compat signature; visual styling is theme-driven now.
  const textColor = "text-[var(--fg)]";
  const linkColor =
    "font-medium text-[var(--fg)] underline decoration-[var(--border)] underline-offset-4 hover:decoration-[var(--muted-2)]";

  return (
    <div className={className ?? ""}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h1
              className={[
                "mt-5 text-base font-semibold tracking-tight first:mt-0",
                textColor,
              ].join(" ")}
              {...props}
            />
          ),
          h2: (props) => (
            <h2
              className={[
                "mt-5 text-sm font-semibold tracking-tight first:mt-0",
                textColor,
              ].join(" ")}
              {...props}
            />
          ),
          h3: (props) => (
            <h3
              className={[
                "mt-4 text-sm font-semibold first:mt-0",
                textColor,
              ].join(" ")}
              {...props}
            />
          ),
          p: (props) => (
            <p className={["mt-3 leading-6 first:mt-0", textColor].join(" ")} {...props} />
          ),
          ul: (props) => (
            <ul className="mt-3 list-disc space-y-1 pl-5" {...props} />
          ),
          ol: (props) => (
            <ol className="mt-3 list-decimal space-y-1 pl-5" {...props} />
          ),
          li: (props) => <li className="pl-0" {...props} />,
          strong: (props) => (
            <strong className="font-semibold text-[var(--fg)]" {...props} />
          ),
          em: (props) => <em className="text-[var(--fg)]" {...props} />,
          blockquote: (props) => (
            <blockquote
              className={[
                "mt-3 border-l pl-4",
                "border-[var(--border)] text-[var(--muted)]",
              ].join(" ")}
              {...props}
            />
          ),
          a: (props) => (
            <a
              {...props}
              className={linkColor}
              target="_blank"
              rel="noreferrer"
            />
          ),
          code: (codeProps) => {
            const { className: codeClassName, children: codeChildren, ...props } = codeProps as unknown as {
              className?: string;
              children?: unknown;
              [key: string]: unknown;
            };
            const inline = Boolean((codeProps as unknown as { inline?: unknown }).inline);
            const raw = normalizeMarkdownText(codeChildren);
            const lang = (codeClassName ?? "").replace("language-", "").trim().toLowerCase();

            if (!inline && (lang === "diff" || lang === "patch")) {
              return <DiffBlock text={raw} tone={tone} />;
            }

            if (inline) {
              return (
                <code
                  className={[
                    "rounded-md border px-1.5 py-0.5 font-mono text-[12px]",
                    "border-[var(--code-border)] bg-[var(--code-bg)] text-[var(--fg)]",
                  ].join(" ")}
                  {...props}
                >
                  {raw}
                </code>
              );
            }

            return (
              <pre
                className={[
                  "mt-3 overflow-auto rounded-xl border p-3 text-[12px] leading-5",
                  "border-[var(--code-border)] bg-[var(--code-bg)]",
                ].join(" ")}
              >
                <code
                  className={[
                    "font-mono",
                    "text-[var(--fg)]",
                  ].join(" ")}
                >
                  {raw.replace(/\n$/, "")}
                </code>
              </pre>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}




