"use client";

import Link from "next/link";
import { CheckIcon } from "@heroicons/react/20/solid";
import { Square2StackIcon } from "@heroicons/react/24/outline";
import { useMemo, useRef, useState } from "react";

type Props = {
  projectShareId: string | null;
  projectName?: string;
};
/**
 * Render the ProjectSharePanel UI (uses memoized values, local state).
 */


export default function ProjectSharePanel({ projectShareId, projectName }: Props) {
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyDone, setCopyDone] = useState(false);

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    if (!projectShareId) return "";
    return `${window.location.origin}/p/${encodeURIComponent(projectShareId)}`;
  }, [projectShareId]);
/**
 * Copy Link (updates state (setIsCopying, setCopyDone); uses setIsCopying, setCopyDone, writeText).
 */


  async function copyLink() {
    if (!shareUrl) return;
    setIsCopying(true);
    setCopyDone(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyDone(true);
      window.setTimeout(() => setCopyDone(false), 1000);
    } catch {
      // ignore
    } finally {
      setIsCopying(false);
    }
  }

  return (
    <aside className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <div className="text-xs font-medium text-[var(--muted)]">Project share link</div>

      <div className="mt-2 flex items-stretch gap-2">
        <input
          ref={shareInputRef}
          value={shareUrl || "Generating link…"}
          readOnly
          className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-[13px] font-medium text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            void copyLink();
          }}
          aria-label="Project share link"
        />
        <button
          type="button"
          onClick={() => void copyLink()}
          disabled={!shareUrl || isCopying}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--primary-bg)] text-[var(--primary-fg)] shadow-sm transition-colors duration-150 hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)] disabled:opacity-50"
          aria-label={copyDone ? "Copied" : "Copy link"}
          title={copyDone ? "Copied" : "Copy link"}
        >
          {copyDone ? <CheckIcon className="h-4 w-4" /> : <Square2StackIcon className="h-4 w-4" />}
          <span className="sr-only">{copyDone ? "Copied" : "Copy"}</span>
        </button>
      </div>

      <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
        <div className="text-[12px] font-medium text-[var(--fg)]">Sharing (placeholder)</div>
        <div className="mt-1 text-[12px] leading-relaxed text-[var(--muted)]">
          Anyone with this link can view this project and open each document via its share page.
        </div>
        <div className="mt-3">
          <Link
            href={projectShareId ? `/p/${encodeURIComponent(projectShareId)}` : "#"}
            target="_blank"
            className={[
              "text-[12px] font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4",
              !projectShareId ? "pointer-events-none opacity-50" : "",
            ].join(" ")}
            aria-label={`Open public share page${projectName ? ` for ${projectName}` : ""}`}
          >
            Open public share page
          </Link>
        </div>
      </div>

      {/* a11y: announce copy state */}
      <div className="sr-only" aria-live="polite">
        {copyDone ? "Copied to clipboard" : ""}
      </div>
    </aside>
  );
}


