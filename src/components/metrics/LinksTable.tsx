/**
 * Links table for the metrics page: people per link in range and when each link was last opened
 * (Pro adds how far people got). Clicking a row filters the page to that link.
 */
"use client";

import Link from "next/link";
import { ChevronRightIcon } from "@heroicons/react/20/solid";
import { awaitingFirstOpen } from "@/lib/analytics/reading";
import { formatCountOf, formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import type { LinkRow, LinkStatus, ReadingTier } from "@/lib/analytics/reading/types";
import { tileLabelClass } from "./KpiStrip";
import { LINK_COMPARE_MIN_PEOPLE, linkLeaders } from "./pageEmphasis";

const LINKS_SHOWN = 10;
const END_LEADER_TITLE = `Highest share reaching the last page among links with ${LINK_COMPARE_MIN_PEOPLE} or more people`;
const TYPICAL_LEADER_TITLE = `Highest typical time per person among links with ${LINK_COMPARE_MIN_PEOPLE} or more people`;

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

/**
 * A default link nobody has used next to other links: it was never sent anywhere, so "not opened
 * yet" would mislead. A lone default link is the one that was shared, so it counts as awaiting.
 */
function unusedDefault(link: LinkRow, links: LinkRow[]): boolean {
  return link.isDefault && link.people === 0 && !link.everOpened && !awaitingFirstOpen(link, links);
}

function sentText(link: LinkRow, now: number): string | null {
  return link.createdAt ? `sent ${formatRelative(link.createdAt, now)}` : null;
}

function LastOpened({ link, links, now }: { link: LinkRow; links: LinkRow[]; now: number }) {
  if (link.people > 0 && link.lastOpenedAt) return <>{formatRelative(link.lastOpenedAt, now)}</>;
  if (link.everOpened && link.lastOpenedAtAllTime) {
    return (
      <span className="text-[var(--muted)]">
        None in this range
        <span className="block text-[11px]">{`last opened ${formatRelative(link.lastOpenedAtAllTime, now)}`}</span>
      </span>
    );
  }
  if (unusedDefault(link, links)) return <span className="text-[var(--muted)]">—</span>;
  const sent = sentText(link, now);
  return (
    <span className="text-[var(--muted)]">
      Not opened yet
      {sent ? <span className="block text-[11px]">{sent}</span> : null}
    </span>
  );
}

function lastOpenedInline(link: LinkRow, links: LinkRow[], now: number): string {
  if (link.people > 0 && link.lastOpenedAt) return `${peopleText(link.people)} · ${formatRelative(link.lastOpenedAt, now)}`;
  if (link.everOpened && link.lastOpenedAtAllTime) return `None in this range, last opened ${formatRelative(link.lastOpenedAtAllTime, now)}`;
  if (unusedDefault(link, links)) return "—";
  const sent = sentText(link, now);
  return sent ? `Not opened yet · ${sent}` : "Not opened yet";
}

/** Per-link table; cards under 640px. */
export default function LinksTable({ docId, links, tier, selectedShareId, now, onSelect }: LinksTableProps) {
  const deep = tier === "deep";
  const ordered = [...links.filter((l) => !unusedDefault(l, links)), ...links.filter((l) => unusedDefault(l, links))];
  const shown = ordered.slice(0, LINKS_SHOWN);
  const grid = deep
    ? "grid-cols-[minmax(0,1fr)_16px] sm:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_16px]"
    : "grid-cols-[minmax(0,1fr)_16px] sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1.4fr)_16px]";
  const leaders = deep ? linkLeaders(shown) : { end: null, typical: null };

  if (links.length === 0) return <p className="text-[13px] text-[var(--muted)]">No links yet.</p>;

  return (
    <div>
      <div className={`hidden gap-3 border-b border-[var(--border)] px-2 pb-2 sm:grid ${grid}`}>
        <div className={tileLabelClass}>Link</div>
        <div className={tileLabelClass}>People</div>
        {deep ? <div className={tileLabelClass}>Reached the last page</div> : null}
        {deep ? <div className={tileLabelClass}>Typical time per person</div> : null}
        <div className={tileLabelClass}>Last opened</div>
        <div aria-hidden="true" />
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {shown.map((l) => {
          const selectable = l.status !== "deleted";
          const selected = l.shareId === selectedShareId;
          const chip = STATUS_CHIP[l.status];
          const withDetail = l.peopleWithDetail ?? 0;
          const reachedEnd = deep && withDetail > 0 ? formatCountOf(l.reachedEnd ?? 0, withDetail) : "—";
          // Fewer than LINK_COMPARE_MIN_PEOPLE people: the figures are muted and not compared.
          const thin = deep && withDetail > 0 && withDetail < LINK_COMPARE_MIN_PEOPLE;
          const typical = deep ? formatDwell(l.medianTotalMs ?? null) : "—";
          const idle = l.people === 0;
          const valueText = idle ? "text-[var(--muted)]" : "text-[var(--fg)]";
          const figureText = idle || thin ? "text-[var(--muted)]" : "text-[var(--fg)]";
          const strongEnd = leaders.end === l.shareId ? " font-semibold" : "";
          const strongTypical = leaders.typical === l.shareId ? " font-semibold" : "";
          const content = (
            <>
              <div className="flex min-w-0 items-center gap-1.5 sm:col-start-1">
                <span className={`truncate text-[13px] font-medium ${valueText}`}>{l.label}</span>
                {l.isDefault ? <span className={chipClass}>Default</span> : null}
                {chip ? <span className={chipClass}>{chip}</span> : null}
              </div>
              <div className={`hidden text-[13px] tabular-nums sm:block ${valueText}`}>{l.people}</div>
              {deep ? (
                <div
                  title={strongEnd ? END_LEADER_TITLE : undefined}
                  className={`hidden items-center gap-2 text-[13px] tabular-nums sm:flex ${figureText}${strongEnd}`}
                >
                  {reachedEnd}
                  {withDetail > 0 ? (
                    <span aria-hidden="true" className="block h-1 w-8 shrink-0 overflow-hidden rounded-full bg-[var(--panel-hover)]">
                      <span
                        className="block h-full rounded-full bg-emerald-500"
                        style={{ width: `${Math.min(1, (l.reachedEnd ?? 0) / withDetail) * 100}%` }}
                      />
                    </span>
                  ) : null}
                </div>
              ) : null}
              {deep ? (
                <div
                  title={strongTypical ? TYPICAL_LEADER_TITLE : undefined}
                  className={`hidden text-[13px] tabular-nums sm:block ${figureText}${strongTypical}`}
                >
                  {typical}
                </div>
              ) : null}
              <div className={`hidden text-[13px] sm:block ${valueText}`}>
                <LastOpened link={l} links={links} now={now} />
              </div>
              <span
                aria-hidden="true"
                className={`col-start-2 row-span-3 row-start-1 flex items-center justify-end self-center text-[var(--muted-2)] sm:col-start-auto sm:row-span-1 sm:row-start-auto ${selectable ? "" : "invisible"}`}
              >
                <ChevronRightIcon className="h-4 w-4" />
              </span>
              <div className="col-start-1 text-[12px] text-[var(--muted)] sm:hidden">{lastOpenedInline(l, links, now)}</div>
              {deep && l.people > 0 ? (
                <div className="col-start-1 text-[12px] text-[var(--muted)] sm:hidden">
                  {`Reached the last page ${reachedEnd} · typical ${formatDwell(l.medianTotalMs ?? null)} per person`}
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
