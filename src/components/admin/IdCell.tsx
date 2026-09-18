/**
 * IdCell — a 24-character Mongo id that does not eat a column.
 *
 * Middle-truncated mono text with the full value in `title`, and a copy button that
 * only shows its ink on row hover / keyboard focus. Optionally links to a detail page.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { ADMIN_DASH, ADMIN_FOCUS_RING, truncateId } from "@/lib/admin/ui";

/** Best-effort clipboard write with a textarea fallback for older browsers. */
async function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export type IdCellProps = {
  value: string | null | undefined;
  /** Characters kept at the head / tail of the truncation. */
  head?: number;
  tail?: number;
  /** Make the id itself a link to its detail page. */
  href?: string;
  /** What the id names, for the copy button's accessible label: "user id". */
  label?: string;
  className?: string;
};

/** A long opaque id, middle-truncated, with the full value in `title` and a copy button. */
export default function IdCell({ value, head = 6, tail = 4, href, label = "id", className }: IdCellProps) {
  const [copied, setCopied] = useState(false);
  const raw = (value ?? "").trim();
  if (!raw) return <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>;

  const short = truncateId(raw, head, tail);
  const text = (
    <span className="font-mono text-[12px] leading-5 text-[var(--muted-2)]" title={raw}>
      {short}
    </span>
  );

  return (
    // `group` on the cell itself as well as on AdminTr: inside a table the copy button
    // still reveals on row hover, and on a detail page (no AdminTr above it) hovering the
    // id reveals it too — otherwise it would sit at opacity-0 forever.
    <span className={cn("group inline-flex items-center gap-1", className)}>
      {href ? (
        <Link href={href} className={cn("rounded hover:underline", ADMIN_FOCUS_RING)}>
          {text}
        </Link>
      ) : (
        text
      )}
      <button
        type="button"
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        title={copied ? "Copied" : raw}
        onClick={() => {
          void (async () => {
            try {
              await copyText(raw);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            } catch {
              /* clipboard unavailable — the title attribute still carries the value */
            }
          })();
        }}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--muted-2)] opacity-0 transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:opacity-100 group-hover:opacity-100",
          ADMIN_FOCUS_RING,
        )}
      >
        {copied ? (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3.5 8.5 6.5 11.5 12.5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
            <path d="M10.5 3.5h-6a1.5 1.5 0 0 0-1.5 1.5v6" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </span>
  );
}
