/**
 * "Needs attention": people active right now, links nobody has opened yet (grouped when there are
 * several), then people worth following up with. Rows come from the API already ranked; person
 * rows are capped and `more` counts the people left out.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { hotReasonText } from "@/lib/analytics/reading/attention";
import { formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import type { AttentionRow } from "@/lib/analytics/reading/types";
import { buildPublicShareUrl } from "@/lib/urls";

/** Copy text to the clipboard and remember which key was copied for 2 seconds. */
export function useCopiedKey(): [string | null, (key: string, text: string) => void] {
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

export const pillActionClass =
  "inline-flex h-8 shrink-0 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 text-[12px] font-semibold text-[var(--fg)]";

export type NeedsAttentionCardProps = {
  rows: AttentionRow[];
  more: number;
  now: number;
  /** Set when the page is filtered to one link, so rows don't repeat its label. */
  shareId: string | null;
  onOpenPerson: (personId: string) => void;
};

type PersonRow = Extract<AttentionRow, { kind: "active" | "hot" }>;
type NotOpenedRow = Extract<AttentionRow, { kind: "not_opened" }>;

const ROWS_SHOWN = 5;

const chipBase = "shrink-0 items-center rounded-full px-2 text-[11px] font-semibold";
const readerChip = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
const neutralChip = "border border-[var(--border)] text-[var(--muted)]";

const rowButtonClass =
  "-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

function rowKey(r: AttentionRow): string {
  return r.kind === "not_opened" ? `n:${r.shareId}` : `${r.kind}:${r.personId}`;
}

const GROUP_KEY = "n:group";

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "sent Aug 30" or "sent Aug 30–Sep 12" across the group's send dates. */
function sentRange(rows: NotOpenedRow[]): string {
  const times = rows.map((r) => Date.parse(r.sentAt)).filter(Number.isFinite);
  if (times.length === 0) return "";
  const first = shortDate(new Date(Math.min(...times)).toISOString());
  const last = shortDate(new Date(Math.max(...times)).toISOString());
  return first === last ? `sent ${first}` : `sent ${first}–${last}`;
}

function Row({
  title,
  sub,
  subNarrow,
  chip,
  chipTone,
  action,
  dot = false,
  onClick,
  expanded,
  indent = false,
}: {
  title: string;
  sub: string;
  /** Phone variant of `sub`, ordered so the part that truncates is the least useful. */
  subNarrow?: string;
  chip: string | null;
  chipTone: "reader" | "neutral";
  action: string;
  dot?: boolean;
  onClick: () => void;
  expanded?: boolean;
  indent?: boolean;
}) {
  const tone = chipTone === "reader" ? readerChip : neutralChip;
  return (
    <button type="button" data-attention-row aria-expanded={expanded} onClick={onClick} className={`${rowButtonClass} ${indent ? "pl-6" : ""}`}>
      {dot ? <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" /> : null}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium text-[var(--fg)]">{title}</span>
          {chip ? <span className={`${chipBase} ${tone} hidden leading-5 lg:inline-flex`}>{chip}</span> : null}
        </span>
        {subNarrow ? (
          <>
            <span className="mt-0.5 block truncate text-[12px] text-[var(--muted)] sm:hidden">{subNarrow}</span>
            <span className="mt-0.5 hidden truncate text-[12px] text-[var(--muted)] sm:block">{sub}</span>
          </>
        ) : (
          <span className="mt-0.5 block truncate text-[12px] text-[var(--muted)]">{sub}</span>
        )}
        {chip ? <span className={`${chipBase} ${tone} mt-1 inline-flex max-w-full whitespace-normal py-0.5 leading-4 min-[480px]:hidden`}>{chip}</span> : null}
      </span>
      {chip ? <span className={`${chipBase} ${tone} hidden leading-5 min-[480px]:inline-flex lg:hidden`}>{chip}</span> : null}
      <span className={pillActionClass}>{action}</span>
    </button>
  );
}

/** Attention list card; renders nothing when there are no rows. */
export default function NeedsAttentionCard({ rows, more, now, shareId, onOpenPerson }: NeedsAttentionCardProps) {
  const [copied, copy] = useCopiedKey();
  const [expanded, setExpanded] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  if (rows.length === 0) return null;

  const people = rows.filter((r): r is PersonRow => r.kind !== "not_opened");
  const notOpened = rows.filter((r): r is NotOpenedRow => r.kind === "not_opened");
  const shownPeople = expanded ? people : people.slice(0, ROWS_SHOWN);
  const hiddenPeople = people.length - shownPeople.length;

  const personItem = (r: PersonRow) => {
    const when = formatRelative(r.kind === "active" ? r.at : r.lastSeen, now);
    const onPage = r.kind === "active" && r.page !== null ? `on page ${r.page}` : null;
    const via = shareId ? null : `via ${r.linkLabel}`;
    const total = r.totalMs > 0 ? formatDwell(r.totalMs) : null;
    const left = r.kind === "hot" && r.exitPage != null ? `left on page ${r.exitPage}` : null;
    const join = (parts: Array<string | null>) => parts.filter(Boolean).join(" · ");
    const sub = join([when, onPage, via, total, left]);
    const subNarrow = join([when, onPage, total, left, via]);
    return (
      <li key={rowKey(r)}>
        <Row
          title={r.name}
          sub={sub}
          subNarrow={subNarrow}
          chip={r.kind === "active" ? "Active now" : hotReasonText(r.reason)}
          chipTone="reader"
          action="Open"
          dot={r.kind === "active"}
          onClick={() => onOpenPerson(r.personId)}
        />
      </li>
    );
  };
  const linkItem = (r: NotOpenedRow, indent: boolean) => {
    const key = rowKey(r);
    return (
      <li key={key}>
        <Row
          title={r.linkLabel}
          sub={`sent ${formatRelative(r.sentAt, now)}`}
          chip={indent ? null : "Not opened yet"}
          chipTone="neutral"
          action={copied === key ? "Copied" : "Copy link"}
          onClick={() => copy(key, buildPublicShareUrl(r.shareId))}
          indent={indent}
        />
      </li>
    );
  };

  return (
    <section data-attention className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-[var(--fg)]">Needs attention</h2>
      <ul className="mt-2 divide-y divide-[var(--border)]">
        {shownPeople.filter((r) => r.kind === "active").map(personItem)}
        {notOpened.length === 1 ? linkItem(notOpened[0], false) : null}
        {notOpened.length > 1 ? (
          <li key={GROUP_KEY}>
            <Row
              title={`${notOpened.length} links not opened yet`}
              sub={sentRange(notOpened)}
              chip={null}
              chipTone="neutral"
              action={groupOpen ? "Hide" : "Show"}
              expanded={groupOpen}
              onClick={() => setGroupOpen((v) => !v)}
            />
            {groupOpen ? <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">{notOpened.map((r) => linkItem(r, true))}</ul> : null}
          </li>
        ) : null}
        {shownPeople.filter((r) => r.kind === "hot").map(personItem)}
      </ul>
      {hiddenPeople > 0 || expanded || more > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {hiddenPeople > 0 || expanded ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex h-11 items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:h-9"
            >
              {expanded ? "Show fewer" : `Show ${hiddenPeople} more`}
            </button>
          ) : null}
          {more > 0 ? <span className="text-[12px] text-[var(--muted)]">{`+${more} more ${more === 1 ? "person" : "people"}`}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
