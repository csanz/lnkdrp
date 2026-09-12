"use client";

import Link from "next/link";
import { CheckIcon } from "@heroicons/react/20/solid";
import { Square2StackIcon } from "@heroicons/react/24/outline";
import { useMemo, useRef, useState } from "react";

type Props = {
  projectShareId: string | null;
  projectName?: string;
  /** Whether `/p/:shareId` resolves. Mirrors the document "Share enabled" switch. */
  shareEnabled: boolean;
  /** Called with the next value when the switch is toggled; the parent persists it. */
  onShareEnabledChange: (next: boolean) => void;
  /** Disables the switch while a save is in flight. */
  shareBusy?: boolean;
};

/**
 * Render the ProjectSharePanel UI: the public project link, copy button, and the visibility switch.
 */
export default function ProjectSharePanel({
  projectShareId,
  projectName,
  shareEnabled,
  onShareEnabledChange,
  shareBusy = false,
}: Props) {
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyDone, setCopyDone] = useState(false);

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    if (!projectShareId) return "";
    return `${window.location.origin}/p/${encodeURIComponent(projectShareId)}`;
  }, [projectShareId]);

  /** Copy the public link to the clipboard and flash the check icon. */
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

  const switchDisabled = !projectShareId || shareBusy;

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

      {/* Same shape as the document panel's "Share enabled" row so the two surfaces read alike. */}
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-[var(--fg)]">Share enabled</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted)]">
            {shareEnabled
              ? "Anyone with the link can view this project and open each shared document."
              : "Sharing is disabled. Visitors will see “This project is no longer shared.”"}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={shareEnabled}
          aria-label="Share enabled"
          aria-busy={shareBusy}
          disabled={switchDisabled}
          className={[
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
            shareEnabled ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
            switchDisabled ? "opacity-50" : "cursor-pointer",
          ].join(" ")}
          onClick={() => onShareEnabledChange(!shareEnabled)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onShareEnabledChange(!shareEnabled);
          }}
        >
          <span
            aria-hidden="true"
            className={[
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
              shareEnabled ? "translate-x-5" : "translate-x-0.5",
            ].join(" ")}
          />
        </button>
      </div>

      <div className="mt-3">
        <Link
          href={projectShareId ? `/p/${encodeURIComponent(projectShareId)}` : "#"}
          target="_blank"
          className={[
            "text-[12px] font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4",
            !projectShareId || !shareEnabled ? "pointer-events-none opacity-50" : "",
          ].join(" ")}
          aria-disabled={!projectShareId || !shareEnabled}
          aria-label={`Open public share page${projectName ? ` for ${projectName}` : ""}`}
        >
          Open public share page
        </Link>
      </div>

      {/* a11y: announce copy state */}
      <div className="sr-only" aria-live="polite">
        {copyDone ? "Copied to clipboard" : ""}
      </div>
    </aside>
  );
}
