/**
 * Links table for the metrics page: people per link in range and when each link was last opened
 * (Pro adds how far people got). Clicking a row filters the page to that link.
 */
"use client";

import Link from "next/link";
import { formatCountOf, formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import type { LinkRow, LinkStatus, ReadingTier } from "@/lib/analytics/reading/types";
import { tileLabelClass } from "./KpiStrip";

const LINKS_SHOWN = 10;

const STATUS_CHIP: Partial<Record<LinkStatus, string>> = {
  disabled: "Disabled",
  expired: "Expired",
  archived: "Archived",
  deleted: "Deleted",
};

export type LinksTableProps = {
  docId: string;
  links: LinkRow[];
  tier: ReadingTier;
  selectedShareId: string | null;
  now: number;
  onSelect: (shareId: string) => void;
};

const chipClass =
  "inline-flex shrink-0 items-center rounded-full border border-[var(--border)] bg-[var(--panel)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--muted)]";

function peopleText(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

function LastOpened({ link, now }: { link: LinkRow; now: number }) {
  if (link.people > 0 && link.lastOpenedAt) return <>{formatRelative(link.lastOpenedAt, now)}</>;
  if (link.everOpened && link.lastOpenedAtAllTime) {
    return (
      <span className="text-[var(--muted)]">
        None in this range
        <span className="block text-[11px]">{`last opened ${formatRelative(link.lastOpenedAtAllTime, now)}`}</span>
      </span>
    );
  }
  return <span className="text-[var(--muted)]">Not opened yet</span>;
}

function lastOpenedInline(link: LinkRow, now: number): string {
  if (link.people > 0 && link.lastOpenedAt) return formatRelative(link.lastOpenedAt, now);
  if (link.everOpened && link.lastOpenedAtAllTime) return `None in this range, last opened ${formatRelative(link.lastOpenedAtAllTime, now)}`;
  return "Not opened yet";
}

/** Per-link table; cards under 640px. */
export default function LinksTable({ docId, links, tier, selectedShareId, now, onSelect }: LinksTableProps) {
  const deep = tier === "deep";
  const shown = links.slice(0, LINKS_SHOWN);
  const grid = deep
    ? "sm:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)]"
    : "sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1.4fr)]";

  if (links.length === 0) return <p className="text-[13px] text-[var(--muted)]">No links yet.</p>;

  return (
    <div>
      <div className={`hidden gap-3 border-b border-[var(--border)] px-2 pb-2 sm:grid ${grid}`}>
        <div className={tileLabelClass}>Link</div>
        <div className={tileLabelClass}>People</div>
        {deep ? <div className={tileLabelClass}>Reached the last page</div> : null}
        {deep ? <div className={tileLabelClass}>Typical time per person</div> : null}
        <div className={tileLabelClass}>Last opened</div>
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {shown.map((l) => {
          const selectable = l.status !== "deleted";
          const selected = l.shareId === selectedShareId;
          const chip = STATUS_CHIP[l.status];
          const reachedEnd =
            deep && (l.peopleWithDetail ?? 0) > 0 ? formatCountOf(l.reachedEnd ?? 0, l.peopleWithDetail ?? 0) : "—";
          const typical = deep ? formatDwell(l.medianTotalMs ?? null) : "—";
          const content = (
            <>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-[var(--fg)]">{l.label}</span>
                {l.isDefault ? <span className={chipClass}>Default</span> : null}
                {chip ? <span className={chipClass}>{chip}</span> : null}
              </div>
              <div className="hidden text-[13px] tabular-nums text-[var(--fg)] sm:block">{l.people}</div>
              {deep ? <div className="hidden text-[13px] tabular-nums text-[var(--fg)] sm:block">{reachedEnd}</div> : null}
              {deep ? <div className="hidden text-[13px] tabular-nums text-[var(--fg)] sm:block">{typical}</div> : null}
              <div className="hidden text-[13px] text-[var(--fg)] sm:block">
                <LastOpened link={l} now={now} />
              </div>
              <div className="text-[12px] text-[var(--muted)] sm:hidden">{`${peopleText(l.people)} · ${lastOpenedInline(l, now)}`}</div>
              {deep ? (
                <div className="text-[12px] text-[var(--muted)] sm:hidden">
                  {`Reached the last page ${reachedEnd} · typical ${typical} per person`}
                </div>
              ) : null}
            </>
          );
          const rowClass = `grid w-full gap-x-3 gap-y-0.5 rounded-lg px-2 py-2.5 text-left sm:items-center ${grid} ${
            selected ? "bg-emerald-500/10" : ""
          }`;
          return (
            <li key={l.shareId}>
              {selectable ? (
                <button
                  type="button"
                  data-link-row
                  aria-pressed={selected}
                  onClick={() => onSelect(l.shareId)}
                  className={`${rowClass} transition hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]`}
                >
                  {content}
                </button>
              ) : (
                <div data-link-row className={rowClass}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {links.length > LINKS_SHOWN ? (
        <Link
          href={`/doc/${encodeURIComponent(docId)}/links`}
          className="mt-2 inline-block text-[13px] font-medium text-[var(--fg)] underline-offset-2 hover:underline"
        >
          {`All ${links.length} links →`}
        </Link>
      ) : null}
    </div>
  );
}
