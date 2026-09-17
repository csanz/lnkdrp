/**
 * Reader sheet header pieces: the title bar (name + Close) that sits in the sheet's sticky header,
 * and the identity block under it (who they are, attention chip, copy and filter actions).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { hotReasonText } from "@/lib/analytics/reading/attention";
import type { HotReason, IdentitySource } from "@/lib/analytics/reading/types";
import { buildPublicShareUrl } from "@/lib/urls";

export type ReaderIdentity = {
  name: string;
  source: IdentitySource;
  email: string | null;
  shareId: string;
  linkLabel: string;
  activeNow: boolean;
  hot: HotReason | null;
};

/** Name (the dialog's accessible label) and the Close button. */
export function ReaderTitleBar({ titleId, name, onClose }: { titleId: string; name: string | null; onClose: () => void }) {
  return (
    <>
      {name !== null ? (
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--fg)]">
          {name}
        </h2>
      ) : (
        <h2 id={titleId} className="min-w-0 flex-1">
          <span className="sr-only">Reader</span>
          <span aria-hidden="true" className="block h-5 w-40 animate-pulse rounded-md bg-[var(--panel-hover)]" />
        </h2>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        </svg>
      </button>
    </>
  );
}

/** "Signed in · a@b.co · via Sequoia", "Anonymous · via Default link", … */
export function identitySubline(p: Pick<ReaderIdentity, "source" | "email" | "linkLabel">): string {
  let who: string;
  if (p.source === "signed_in") who = p.email ? `Signed in · ${p.email}` : "Signed in";
  else if (p.source === "introduced")
    who = p.email ? `${p.email} · entered by the reader, not verified` : "Introduced themselves · not verified";
  else who = "Anonymous";
  return `${who} · via ${p.linkLabel}`;
}

function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = (key: string, text: string) => {
    if (!text) return;
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(key);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => {});
  };
  return [copied, copy];
}

const actionClass =
  "inline-flex h-8 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

/** Identity sub-line, attention chip and actions. Actions are omitted when `actions` is false (loading seed). */
export default function ReaderHeader({
  person,
  filteredShareId,
  onFilterLink,
  actions = true,
}: {
  person: ReaderIdentity;
  filteredShareId: string | null;
  onFilterLink?: (shareId: string) => void;
  actions?: boolean;
}) {
  const [copied, copy] = useCopied();
  const chip = person.activeNow ? "Active in the last 10 minutes" : person.hot ? hotReasonText(person.hot) : null;
  const showFilter = Boolean(onFilterLink) && filteredShareId !== person.shareId;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[var(--muted)]">{identitySubline(person)}</p>
      {chip ? (
        <span
          data-reader-chip
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--fg)]"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "rgb(16 185 129)" }} />
          {chip}
        </span>
      ) : null}
      {actions ? (
        <div className="flex flex-wrap gap-2">
          {person.email ? (
            <button type="button" className={actionClass} onClick={() => copy("email", person.email ?? "")}>
              {copied === "email" ? "Copied" : "Copy email"}
            </button>
          ) : null}
          <button type="button" className={actionClass} onClick={() => copy("link", buildPublicShareUrl(person.shareId))}>
            {copied === "link" ? "Copied" : "Copy link"}
          </button>
          {showFilter ? (
            <button type="button" className={actionClass} onClick={() => onFilterLink?.(person.shareId)}>
              Only this link
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
