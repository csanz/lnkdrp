/**
 * Empty state for a range with nobody in it: says whether it was ever opened (Pro offers the
 * smallest range that includes the last open), then lists the active links, never-opened first,
 * so the owner can copy one and send it again.
 */
"use client";

import Link from "next/link";
import { ALLOWED_DAYS } from "@/lib/analytics/reading/constants";
import { formatRelative, rangeLabel } from "@/lib/analytics/reading/format";
import type { LinkRow, ReadingTier } from "@/lib/analytics/reading/types";
import { buildPublicShareUrl } from "@/lib/urls";
import { pillActionClass, useCopiedKey } from "./NeedsAttentionCard";

export type EmptyReadingProps = {
  docId: string;
  days: number;
  everOpened: boolean;
  lastOpenedAtAllTime: string | null;
  links: LinkRow[];
  shareId: string | null;
  /** All-time owner previews; null when unknown. */
  ownerPreviewsAllTime: number | null;
  now: number;
  tier: ReadingTier;
  onDays: (days: AllowedDays) => void;
};

type AllowedDays = (typeof ALLOWED_DAYS)[number];

const LINKS_SHOWN = 5;
const DAY_MS = 86_400_000;

/** Smallest allowed range wider than `days` whose window reaches back to `lastOpened`; null when none does. */
export function rangeReaching(lastOpened: string | null, days: number, now: number): AllowedDays | null {
  const t = lastOpened ? Date.parse(lastOpened) : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
  return ALLOWED_DAYS.find((d) => d > days && now - t <= d * DAY_MS) ?? null;
}

/** Empty reading state with the link list. */
export default function EmptyReading({
  docId,
  days,
  everOpened,
  lastOpenedAtAllTime,
  links,
  shareId,
  ownerPreviewsAllTime,
  now,
  tier,
  onDays,
}: EmptyReadingProps) {
  const [copied, copy] = useCopiedKey();
  const inScope = links.filter((l) => l.status === "active" && (!shareId || l.shareId === shareId));
  // Never-opened links lead (the longest-waiting first) since they are the ones to chase; then the most recently opened.
  const unopened = inScope
    .filter((l) => !l.everOpened)
    .sort((x, y) => (x.createdAt ? Date.parse(x.createdAt) : Infinity) - (y.createdAt ? Date.parse(y.createdAt) : Infinity));
  const opened = inScope
    .filter((l) => l.everOpened)
    .sort((x, y) => (y.lastOpenedAtAllTime ? Date.parse(y.lastOpenedAtAllTime) : 0) - (x.lastOpenedAtAllTime ? Date.parse(x.lastOpenedAtAllTime) : 0));
  const active = [...unopened, ...opened];
  const overflow = active.length - LINKS_SHOWN;
  const widen = everOpened && tier === "deep" ? rangeReaching(lastOpenedAtAllTime, days, now) : null;

  return (
    <div data-empty-reading className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-5">
      {everOpened ? (
        <>
          <p className="text-[15px] font-semibold text-[var(--fg)]">{`No one opened this in the last ${rangeLabel(days)}.`}</p>
          {lastOpenedAtAllTime ? (
            <p className="mt-0.5 text-[13px] text-[var(--muted)]">{`Last opened ${formatRelative(lastOpenedAtAllTime, now)}.`}</p>
          ) : null}
          {widen ? (
            <button
              type="button"
              data-empty-widen
              onClick={() => onDays(widen)}
              className="mt-3 inline-flex h-11 items-center rounded-lg bg-[var(--primary-bg)] px-3.5 text-[13px] font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] sm:h-9"
            >
              {`Show last ${rangeLabel(widen)}`}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-[15px] font-semibold text-[var(--fg)]">No one has opened this yet.</p>
          {ownerPreviewsAllTime !== null && ownerPreviewsAllTime > 0 ? (
            <p className="mt-0.5 text-[13px] text-[var(--muted)]">
              {"Only you have opened it so far — your own previews aren't counted."}
            </p>
          ) : null}
        </>
      )}

      {active.length > 0 ? (
        <div className="mt-4">
          <p className="text-[12px] font-semibold text-[var(--muted-2)]">
            {`Sent via ${active.length} ${active.length === 1 ? "link" : "links"}`}
          </p>
          <ul className="mt-1 divide-y divide-[var(--border)]">
            {active.slice(0, LINKS_SHOWN).map((l) => (
              <li key={l.shareId} className="flex min-h-12 items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--fg)]">{l.label}</span>
                  <span className="block truncate text-[12px] text-[var(--muted)]">
                    {l.everOpened && l.lastOpenedAtAllTime
                      ? `last opened ${formatRelative(l.lastOpenedAtAllTime, now)}`
                      : !everOpened
                        ? l.createdAt
                          ? `sent ${formatRelative(l.createdAt, now)}`
                          : null
                        : l.createdAt
                          ? `not opened yet · sent ${formatRelative(l.createdAt, now)}`
                          : "not opened yet"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => copy(l.shareId, buildPublicShareUrl(l.shareId))}
                  className={`${pillActionClass.replace("h-8", "h-11 sm:h-8")} hover:bg-[var(--panel-hover)]`}
                >
                  {copied === l.shareId ? "Copied" : "Copy link"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Link
        href={`/doc/${encodeURIComponent(docId)}/links`}
        className="-mx-2 mt-2 inline-flex h-11 items-center rounded-lg px-2 text-[13px] font-medium text-[var(--fg)] underline-offset-2 hover:underline sm:h-8"
      >
        {overflow > 0 ? `+${overflow} more ${overflow === 1 ? "link" : "links"} →` : "All links →"}
      </Link>
    </div>
  );
}
