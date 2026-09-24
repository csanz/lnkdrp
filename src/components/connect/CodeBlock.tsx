"use client";

import { useState } from "react";

/**
 * A copyable code block on the app's tokens. Each line is its own block with a hanging indent so a
 * wrapped continuation tucks under its flag; the clipboard gets the lines joined with newlines.
 * Clipboard access can be unavailable (permissions, insecure context): the text stays selectable.
 */
export default function CodeBlock({
  lines,
  label,
  size = "md",
  className = "",
}: {
  lines: string[];
  /** Accessible name for the Copy button, e.g. "Copy install command". */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; the text is selectable.
    }
  };

  // The button gets its own column instead of floating over the code. Floated at the top right
  // with a transparent background, it sat on top of whatever the horizontal scroll brought under
  // it: a long install line read "http://localhost:87COPY" and the scrollbar ran beneath the label.
  return (
    <div className={["flex items-start rounded-xl border border-[var(--border)] bg-[var(--panel-2)]", className].join(" ")}>
      <pre
        className={[
          "min-w-0 flex-1 select-text overflow-x-auto whitespace-pre px-4 pb-3.5 pt-3.5 font-mono leading-6 text-[var(--fg)]",
          size === "sm" ? "text-[12px]" : "text-[12.5px]",
        ].join(" ")}
      >
        <code>
          {lines.map((l, i) => (
            <span key={i} className="block pl-5 -indent-5">
              {l}
            </span>
          ))}
        </code>
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : label}
        className="mr-3 mt-2.5 shrink-0 rounded-md px-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-2)] transition-colors hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none sm:py-0.5"
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
