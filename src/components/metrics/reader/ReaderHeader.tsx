/**
 * Reader sheet header pieces: the title bar (name + Close) that sits in the sheet's sticky header,
 * and the identity block under it (who they are, which link, attention chip), then whatever the body
 * slots in (the verdict), then the follow-up, copy and filter actions.
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
  isDefaultLink?: boolean;
  firstSeen?: string;
};

const closeClass =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-9 sm:w-9";

/** Name (the dialog's accessible label) and the Close button. `name` null shows a loading placeholder. */
export function ReaderTitleBar({ titleId, name, onClose }: { titleId: string; name: string | null; onClose: () => void }) {
  return (
    <>
      {name !== null ? (
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--fg)]" title={name}>
          {name}
        </h2>
      ) : (
        <h2 id={titleId} className="min-w-0 flex-1">
          <span className="sr-only">Reader</span>
          <span aria-hidden="true" className="block h-5 w-40 animate-pulse rounded-md bg-[var(--panel-hover)]" />
        </h2>
      )}
      <button type="button" aria-label="Close" onClick={onClose} className={closeClass}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        </svg>
      </button>
    </>
  );
}

/** "Signed in · a@b.co", "a@b.co · entered by the reader, not verified", "Didn't give a name". */
export function identityLine(p: Pick<ReaderIdentity, "source" | "email">): string {
  if (p.source === "anonymous") return "Didn't give a name";
  if (p.source === "signed_in") return p.email ? `Signed in · ${p.email}` : "Signed in";
  return p.email ? `${p.email} · entered by the reader, not verified` : "Introduced themselves · not verified";
}

/** "Copy the Sequoia link"; "Copy the Default link" when the label already ends in "link". */
export function copyLinkLabel(linkLabel: string): string {
  return /\blink$/i.test(linkLabel.trim()) ? `Copy the ${linkLabel.trim()}` : `Copy the ${linkLabel.trim()} link`;
}

/** "Email Dana" for a named reader, plain "Email" when the name is an address or a placeholder. */
export function emailActionLabel(p: Pick<ReaderIdentity, "name" | "source">): string {
  const name = p.name.trim();
  if (p.source === "anonymous" || !name || name.includes("@") || /^anonymous\b/i.test(name)) return "Email";
  return `Email ${name.split(/\s+/)[0]}`;
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
  "inline-flex h-11 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-8 sm:px-2.5 sm:text-[12px]";
const primaryActionClass =
  "inline-flex h-11 items-center justify-center rounded-lg bg-[var(--primary-bg)] px-3 text-[13px] font-semibold text-[var(--primary-fg)] transition hover:bg-[var(--primary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] sm:h-8 sm:px-2.5 sm:text-[12px]";
const menuItemClass =
  "flex h-11 w-full items-center px-3 text-left text-[13px] font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] focus-visible:bg-[var(--panel-hover)] focus-visible:outline-none";

type Action = { key: string; label: string; ariaLabel?: string; title?: string; href?: string; primary?: boolean; onSelect?: () => void };

/** Under 640px: the first action as a full-width button plus a "More" menu for the rest. */
function CompactActions({ actions }: { actions: Action[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [first, ...rest] = actions;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Window capture runs before the sheet's document-level Escape handler, so Escape closes only the menu.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      moreRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    wrapRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  if (!first) return null;
  return (
    <div ref={wrapRef} data-reader-actions-compact className="relative flex gap-2 sm:hidden">
      <ActionControl action={first} className={`${first.primary ? primaryActionClass : actionClass} flex-1`} />
      {rest.length > 0 ? (
        <>
          <button
            ref={moreRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={`${actionClass} min-w-11`}
          >
            More
          </button>
          {open ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-10 mt-1 min-w-48 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)] py-1 shadow-lg"
            >
              {rest.map((a) => (
                <ActionControl key={a.key} action={a} className={menuItemClass} role="menuitem" />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ActionControl({ action, className, role }: { action: Action; className: string; role?: string }) {
  if (action.href) {
    return (
      <a className={className} href={action.href} role={role}>
        {action.label}
      </a>
    );
  }
  return (
    <button
      type="button"
      role={role}
      className={className}
      title={action.title}
      aria-label={action.ariaLabel}
      onClick={action.onSelect}
    >
      {action.label}
    </button>
  );
}

/**
 * Identity and link lines, attention chip, `children` (the verdict), then actions. Actions are omitted
 * when `actions` is false (loading seed).
 */
export default function ReaderHeader({
  person,
  filteredShareId,
  onFilterLink,
  actions = true,
  verdictBehaviour = null,
  verdictPage = null,
  docTitle = null,
  children,
}: {
  person: ReaderIdentity;
  filteredShareId: string | null;
  onFilterLink?: (shareId: string) => void;
  actions?: boolean;
  /** The verdict's behaviour sentence; the chip is hidden when it says the same thing. */
  verdictBehaviour?: string | null;
  /** The page the verdict calls out; a dwell chip about the same page is hidden. */
  verdictPage?: number | null;
  /** Subject line for the follow-up email. */
  docTitle?: string | null;
  /** Shown between the identity block and the actions. */
  children?: React.ReactNode;
}) {
  const [copied, copy] = useCopied();
  const chipText = person.activeNow ? "Active in the last 10 minutes" : person.hot ? hotReasonText(person.hot) : null;
  const repeatsVerdict =
    !person.activeNow &&
    ((chipText ?? "").trim() === (verdictBehaviour ?? "").trim() ||
      // "Came back 2 days later" chip over a behaviour that opens with those words.
      Boolean(chipText && (verdictBehaviour ?? "").startsWith(chipText.trim())) ||
      (person.hot?.kind === "dwell" && verdictPage !== null && person.hot.page === verdictPage));
  const chip = chipText && !repeatsVerdict ? chipText : null;
  const showFilter = Boolean(onFilterLink) && filteredShareId !== person.shareId;
  const copyLabel = copyLinkLabel(person.linkLabel);
  const showDefaultChip = Boolean(person.isDefaultLink) && !/default/i.test(person.linkLabel);

  const actionList: Action[] = [];
  if (person.email) {
    actionList.push({
      key: "email",
      label: emailActionLabel(person),
      href: `mailto:${person.email}?subject=${encodeURIComponent(docTitle ?? "")}`,
      primary: true,
    });
    actionList.push({ key: "copy-email", label: copied === "email" ? "Copied" : "Copy email", onSelect: () => copy("email", person.email ?? "") });
  }
  actionList.push({
    key: "copy-link",
    label: copied === "link" ? "Copied" : "Copy link",
    title: copyLabel,
    ariaLabel: copied === "link" ? "Copied" : copyLabel,
    onSelect: () => copy("link", buildPublicShareUrl(person.shareId)),
  });
  if (showFilter) actionList.push({ key: "filter", label: "Only this link", onSelect: () => onFilterLink?.(person.shareId) });

  return (
    <div className="space-y-3">
      <div className="space-y-0.5 text-[13px] text-[var(--muted)]">
        <p data-reader-identity>{identityLine(person)}</p>
        <p data-reader-link>
          {"Link: "}
          <span className="font-medium text-[var(--fg)]">{person.linkLabel}</span>
          {showDefaultChip ? (
            <span className="ml-1.5 inline-block rounded-full border border-[var(--border)] px-1.5 py-px align-[1px] text-[10px] font-semibold text-[var(--muted-2)]">
              Default
            </span>
          ) : null}
        </p>
      </div>
      {chip ? (
        <span
          data-reader-chip
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1 text-[12px] font-semibold text-[var(--fg)]"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "rgb(16 185 129)" }} />
          {chip}
        </span>
      ) : null}
      {children}
      {actions ? (
        <>
          <div className="hidden gap-2 sm:flex sm:flex-wrap">
            {actionList.map((a) => (
              <ActionControl key={a.key} action={a} className={a.primary ? primaryActionClass : actionClass} />
            ))}
          </div>
          <CompactActions actions={actionList} />
        </>
      ) : null}
    </div>
  );
}
