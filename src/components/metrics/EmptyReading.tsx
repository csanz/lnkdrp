/**
 * Empty state for a range with nobody in it: says whether it was ever opened, then lists the
 * active links so the owner can copy one and send it again.
 */
"use client";

import Link from "next/link";
import { formatRelative, rangeLabel } from "@/lib/analytics/reading/format";
import type { LinkRow } from "@/lib/analytics/reading/types";
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
};

const LINKS_SHOWN = 5;

/** Empty reading state with the link list. */
export default function EmptyReading({ docId, days, everOpened, lastOpenedAtAllTime, links, shareId, ownerPreviewsAllTime, now }: EmptyReadingProps) {
  const [copied, copy] = useCopiedKey();
  const active = links.filter((l) => l.status === "active" && (!shareId || l.shareId === shareId));

  return (
    <div data-empty-reading className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-4 sm:p-5">
      {everOpened ? (
        <>
          <p className="text-[15px] font-semibold text-[var(--fg)]">{`No one opened this in the last ${rangeLabel(days)}.`}</p>
          {lastOpenedAtAllTime ? (
            <p className="mt-0.5 text-[13px] text-[var(--muted)]">{`Last opened ${formatRelative(lastOpenedAtAllTime, now)}.`}</p>
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
                      : "not opened yet"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => copy(l.shareId, buildPublicShareUrl(l.shareId))}
                  className={`${pillActionClass} hover:bg-[var(--panel-hover)]`}
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
        className="mt-3 inline-block text-[13px] font-medium text-[var(--fg)] underline-offset-2 hover:underline"
      >
        All links →
      </Link>
    </div>
  );
}
