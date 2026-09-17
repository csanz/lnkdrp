/**
 * "Needs attention": people active right now, people worth following up with, and links nobody
 * has opened yet. Rows come from the API already ranked and capped.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { hotReasonText } from "@/lib/analytics/reading/attention";
import { formatRelative } from "@/lib/analytics/reading/format";
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
  onOpenPerson: (personId: string) => void;
};

function rowKey(r: AttentionRow): string {
  return r.kind === "not_opened" ? `n:${r.shareId}` : `${r.kind}:${r.personId}`;
}

/** Attention list card; renders nothing when there are no rows. */
export default function NeedsAttentionCard({ rows, more, now, onOpenPerson }: NeedsAttentionCardProps) {
  const [copied, copy] = useCopiedKey();
  if (rows.length === 0) return null;

  return (
    <section data-attention className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-[var(--fg)]">Needs attention</h2>
      <ul className="mt-2 divide-y divide-[var(--border)]">
        {rows.map((r) => {
          const key = rowKey(r);
          let title: string;
          let sub: string;
          let action: string;
          let onClick: () => void;
          if (r.kind === "active") {
            title = `${r.name} · active ${formatRelative(r.at, now)}`;
            sub = `via ${r.linkLabel}${r.page !== null ? ` · last on page ${r.page}` : ""}`;
            action = "Open";
            onClick = () => onOpenPerson(r.personId);
          } else if (r.kind === "hot") {
            title = `${r.name} · ${hotReasonText(r.reason)}`;
            sub = `via ${r.linkLabel}`;
            action = "Open";
            onClick = () => onOpenPerson(r.personId);
          } else {
            title = `${r.linkLabel} · not opened yet`;
            sub = `Sent ${formatRelative(r.sentAt, now)}`;
            action = copied === key ? "Copied" : "Copy link";
            onClick = () => copy(key, buildPublicShareUrl(r.shareId));
          }
          return (
            <li key={key}>
              <button
                type="button"
                data-attention-row
                onClick={onClick}
                className="-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${r.kind === "active" ? "" : "invisible"}`}
                  style={{ backgroundColor: "rgb(16 185 129)" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-[var(--fg)] [overflow-wrap:anywhere] sm:truncate">{title}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--muted)]">{sub}</span>
                </span>
                <span className={pillActionClass}>{action}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 ? <p className="mt-2 text-[12px] text-[var(--muted)]">+{more} more</p> : null}
    </section>
  );
}
