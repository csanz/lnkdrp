/**
 * Key facts for one person: where they left, their longest pages, the page most above its typical
 * time, visits (or when they opened it), total time, pages stayed on and downloads. A one-visit bounce
 * (page 2 or less) swaps the page facts and Stayed on for how long a typical person spent.
 */
import { calendarDaysBetween, formatDwell, formatRelative, formatTypical } from "@/lib/analytics/reading";
import type { PersonPageRow, PersonResponse, PersonVisitRow } from "@/lib/analytics/reading/types";
import { coverTimedVisits } from "./coverVisits";
import { formatRatio } from "./ReaderPageBars";

const NBSP = "\u00a0";
const RATIO_SHOWN_FROM = 2;
const LONGEST_PAGES = 2;
/** A second longest page is listed only from this long and this share of the first. */
const SECOND_LONGEST_MIN_MS = 10_000;
const SECOND_LONGEST_MIN_SHARE = 0.25;

/**
 * "Sep 10, 1:42 PM" in the viewer's time zone (", 2025" before the time when not in `now`'s year),
 * joined with no-break spaces so the time never wraps apart; "—" when unparseable.
 */
export function formatDateTimeShort(iso: string, now?: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const otherYear = now !== undefined && d.getFullYear() !== new Date(now).getFullYear();
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: otherYear ? "numeric" : undefined });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date},${NBSP}${time}`.replace(/\s/g, NBSP);
}

/**
 * formatRelative, except that past a week it keeps counting ("12 days ago", "3 months ago") instead
 * of falling back to a date, which would repeat the date shown beside it.
 */
export function agoText(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  // Calendar days, like formatRelative and the dates beside it, not 24-hour blocks.
  const days = calendarDaysBetween(t, now);
  if (days < 7) return formatRelative(t, now);
  if (days < 60) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.floor(days / 365)} years ago`;
}

function pageName(p: PersonPageRow): string {
  return p.shortLabel ? `Page ${p.page} · ${p.shortLabel}` : `Page ${p.page}`;
}

/**
 * Stayed pages worth calling out. Page 1 drops out when its time adds up over several visits: every
 * return lands on the cover, so its total says more about coming back than about the page.
 */
function stayedPages(pages: PersonPageRow[], visits: PersonVisitRow[]): PersonPageRow[] {
  const coverVisits = coverTimedVisits(visits);
  return pages.filter((p) => p.state === "read" && p.ms > 0 && !(p.page === 1 && coverVisits > 1));
}

/** The longest stayed page, plus the next one when it isn't trivial beside it. */
export function longestPages(pages: PersonPageRow[], visits: PersonVisitRow[]): PersonPageRow[] {
  const [first, ...rest] = stayedPages(pages, visits)
    .sort((a, b) => b.ms - a.ms || a.page - b.page)
    .slice(0, LONGEST_PAGES);
  if (!first) return [];
  return [first, ...rest.filter((p) => p.ms >= SECOND_LONGEST_MIN_MS && p.ms >= SECOND_LONGEST_MIN_SHARE * first.ms)];
}

/** "Page 10 · Financials 47s" */
export function longestPageText(p: PersonPageRow): string {
  return `${pageName(p)} ${formatDwell(p.ms)}`;
}

/** "Page 10 · Financials 47s, Page 12 · Appendix 39s"; null when nothing was stayed on. */
export function longestPagesText(pages: PersonPageRow[], visits: PersonVisitRow[]): string | null {
  const top = longestPages(pages, visits);
  return top.length > 0 ? top.map(longestPageText).join(", ") : null;
}

/**
 * "Stayed on 8 of 12" with "3 jumped past · 1 under 2s · 1 time not recorded" for the pages that
 * weren't stayed on (null when there are none). Counts come from the page rows, so they add up to
 * the rows shown below.
 */
export function stayedOnFact(pages: PersonPageRow[], pageCount: number): { value: string; sub: string | null } {
  const n = (state: PersonPageRow["state"]) => pages.filter((p) => p.state === state).length;
  const unknown = n("unknown");
  const parts = [
    n("jumped") > 0 ? `${n("jumped")} jumped past` : null,
    n("passed") > 0 ? `${n("passed")} under 2s` : null,
    unknown > 0 ? `${unknown} ${unknown === 1 ? "time" : "times"} not recorded` : null,
  ].filter((x): x is string => x !== null);
  return { value: `${n("read")} of ${pageCount}`, sub: parts.length > 0 ? parts.join(" · ") : null };
}

/**
 * The stayed page with the highest API ratio (2× or more), unless it's already a longest page or the
 * page the verdict names.
 */
export function aboveTypicalRow(pages: PersonPageRow[], visits: PersonVisitRow[], verdictPage: number | null): PersonPageRow | null {
  const longest = new Set(longestPages(pages, visits).map((p) => p.page));
  const best = stayedPages(pages, visits)
    .filter((p) => p.typicalMs !== null && (p.ratio ?? 0) >= RATIO_SHOWN_FROM)
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || b.ms - a.ms || a.page - b.page)[0];
  if (!best || longest.has(best.page) || best.page === verdictPage) return null;
  return best;
}

/** "Page 8 · Pricing — 5.6× (44s vs 7s typical)" */
export function aboveTypicalText(p: PersonPageRow): string {
  return `${pageName(p)} — ${formatRatio(p.ratio ?? 0)} (${formatDwell(p.ms)} vs ${formatTypical(p.typicalMs)} typical)`;
}

function Fact({
  label,
  children,
  title,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  title?: string;
  sub?: string | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">{label}</dt>
      <dd className="mt-1 line-clamp-3 text-sm font-semibold text-[var(--fg)]" title={title}>
        {children}
      </dd>
      {sub ? <dd className="mt-0.5 text-[12px] text-[var(--muted)]">{sub}</dd> : null}
    </div>
  );
}

/** Two columns under 640px, three from 640px. */
export default function ReaderFacts({ data, now }: { data: PersonResponse; now: number }) {
  const { person, facts, pageCount, pages, visits } = data;
  const exitRow = facts.exitPage === null ? null : pages.find((p) => p.page === facts.exitPage);
  const exitLabel = exitRow?.label ?? null;
  const exitShort = exitRow?.shortLabel ?? exitLabel;
  const leftOn = facts.exitPage === null ? "—" : exitShort ? `Page ${facts.exitPage} · ${exitShort}` : `Page ${facts.exitPage}`;
  const leftOnTitle = facts.exitPage !== null && exitLabel ? `Page ${facts.exitPage} · ${exitLabel}` : undefined;
  const stayedOn = stayedOnFact(pages, pageCount);
  const bounce = facts.visits === 1 && facts.maxPage <= 2;
  const longest = bounce ? [] : longestPages(pages, visits);
  const above = bounce ? null : aboveTypicalRow(pages, visits, data.verdict.page);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3" data-reader-facts>
      <Fact label="Left on" title={leftOnTitle}>
        {leftOn}
      </Fact>
      {longest.length > 0 ? (
        <Fact label={longest.length === 1 ? "Longest page" : "Longest pages"} title={longestPagesText(pages, visits) ?? undefined}>
          {longest.map((p, i) => (
            <span key={p.page} className="block">
              {`${pageName(p)} `}
              <span className="whitespace-nowrap">{i < longest.length - 1 ? `${formatDwell(p.ms)},` : formatDwell(p.ms)}</span>
            </span>
          ))}
        </Fact>
      ) : null}
      {above ? (
        <Fact
          label={data.verdict.page !== null ? "Also above typical" : "Above typical"}
          sub={`${formatDwell(above.ms)} vs ${formatTypical(above.typicalMs)} typical`}
          title={aboveTypicalText(above)}
        >
          {`${pageName(above)} — ${formatRatio(above.ratio ?? 0)}`}
        </Fact>
      ) : null}
      {facts.visits === 1 ? (
        <Fact label="Opened" sub={agoText(person.lastSeen, now)}>
          {formatDateTimeShort(visits[0]?.startedAt ?? person.firstSeen, now)}
        </Fact>
      ) : (
        <>
          <Fact label="Visits" sub={`latest ${agoText(person.lastSeen, now)}`}>
            {String(facts.visits)}
          </Fact>
          <Fact label="First seen">{formatDateTimeShort(person.firstSeen, now)}</Fact>
        </>
      )}
      <Fact label="Total time">{formatDwell(facts.totalMs)}</Fact>
      {bounce ? null : (
        <Fact label="Stayed on" sub={stayedOn.sub}>
          {stayedOn.value}
        </Fact>
      )}
      {bounce && facts.typicalTotalMs !== null ? (
        <Fact label="Typical person">{formatDwell(facts.typicalTotalMs)}</Fact>
      ) : null}
      {person.downloads > 0 ? <Fact label="Downloads">{String(person.downloads)}</Fact> : null}
    </dl>
  );
}
