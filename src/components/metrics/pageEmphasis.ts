/**
 * Shared rules for the metrics page's page-level figures: which cells are emphasised (exactly the
 * pages the callouts name, so bold and callouts never disagree), how a page's typical time is shown
 * for its number of stayers, which link figures may be bolded, short page and link labels, and the
 * wording for a page with too few stayers for a typical time.
 */

import { CALLOUT_MIN_PEOPLE } from "@/lib/analytics/reading/constants";
import { formatDwell } from "@/lib/analytics/reading/format";
import type { Callouts, LinkRow, PageRow } from "@/lib/analytics/reading/types";

export type EmphasisPages = { typical: ReadonlySet<number>; skipped: ReadonlySet<number>; left: ReadonlySet<number> };

export type TiedPage = { page: number; typicalMs: number; readCount: number };

const NONE: ReadonlySet<number> = new Set();

type HeldLongest = NonNullable<Callouts["heldLongest"]>;

/**
 * The tied "held attention longest" pages with their own stayer counts, page ascending. Reads the
 * API's `tied`, else (an older response) rebuilds it from `tiedPages` and the page rows.
 */
export function heldLongestTied(held: HeldLongest, pages: PageRow[]): TiedPage[] {
  if (Array.isArray(held.tied) && held.tied.length > 0) return [...held.tied].sort((a, b) => a.page - b.page);
  const list = held.tiedPages.length > 0 ? held.tiedPages : [held.page];
  return [...list]
    .sort((a, b) => a - b)
    .map((p) =>
      p === held.page
        ? { page: p, typicalMs: held.typicalMs, readCount: held.readCount }
        : { page: p, typicalMs: pages[p - 1]?.typicalMs ?? held.typicalMs, readCount: pages[p - 1]?.readCount ?? 0 },
    );
}

function tiedList(c: { page: number; tiedPages: number[] } | null): number[] {
  if (!c) return [];
  return c.tiedPages.length ? c.tiedPages : [c.page];
}

/** Pages to bold per column; the last page's Left here is never emphasised. */
export function emphasisPages(callouts: Callouts | null | undefined, pageCount: number, pages: PageRow[] = []): EmphasisPages {
  if (!callouts) return { typical: NONE, skipped: NONE, left: NONE };
  const c = callouts;
  const typical = c.heldLongest ? heldLongestTied(c.heldLongest, pages).map((t) => t.page) : [];
  return {
    typical: new Set(typical),
    skipped: new Set(tiedList(c.mostSkipped)),
    left: new Set(tiedList(c.mostLeft).filter((p) => p !== pageCount)),
  };
}

/**
 * How a page's typical time may be shown, one rule for the matrix footer and the page table:
 * `ranked` (enough stayers for highlights, may be bold), `thin` (a typical time exists but too few
 * stayers to rank it: muted, never bold), `few` (1–2 stayers: no typical time, only their times),
 * `none` (nobody stayed).
 */
export type TypicalDisplay =
  | { kind: "ranked"; ms: number; readCount: number }
  | { kind: "thin"; ms: number; readCount: number; title: string }
  | { kind: "few"; text: string }
  | { kind: "none" };

export function typicalDisplay(row: PageRow | undefined): TypicalDisplay {
  if (!row) return { kind: "none" };
  if (row.typicalMs !== null && row.readCount >= CALLOUT_MIN_PEOPLE) return { kind: "ranked", ms: row.typicalMs, readCount: row.readCount };
  if (row.typicalMs !== null) {
    return {
      kind: "thin",
      ms: row.typicalMs,
      readCount: row.readCount,
      title: `${row.readCount} ${row.readCount === 1 ? "person" : "people"} stayed; highlights need ${CALLOUT_MIN_PEOPLE}`,
    };
  }
  const few = fewStayersText(row.fewMs);
  return few ? { kind: "few", text: few } : { kind: "none" };
}

/** True when some page with a typical time too thin to rank beats the "held attention longest" leader. */
export function thinPageBeatsLeader(held: HeldLongest, pages: PageRow[]): boolean {
  return pages.some((p) => typicalDisplay(p).kind === "thin" && (p.typicalMs ?? 0) > held.typicalMs);
}

/** Short page label for tight spots ("Pricing"), falling back to the full label. */
export function pageShortLabel(row: PageRow | undefined): string | null {
  if (!row) return null;
  return row.shortLabel || row.label || null;
}

/** "Page 3 · Pricing". */
export function pageHeadline(page: number, row: PageRow | undefined): string {
  const short = pageShortLabel(row);
  return `Page ${page}${short ? ` · ${short}` : ""}`;
}

/** Recipient part of a link label: "Kleiner Perkins" for "Kleiner Perkins — Felix Whitaker". */
export function shortLinkLabel(label: string): string {
  const i = label.indexOf(" — ");
  return i > 0 ? label.slice(0, i) : label;
}

/** "2 people stayed: 58s, 4s" / "1 person stayed: 58s" for a page with fewer stayers than a typical time needs. */
export function fewStayersText(fewMs: number[] | null | undefined): string | null {
  if (!fewMs || fewMs.length === 0) return null;
  return `${fewMs.length === 1 ? "1 person" : `${fewMs.length} people`} stayed: ${fewMs.map((ms) => formatDwell(ms)).join(", ")}`;
}

/** "a, b and c". */
export function joinAnd(items: Array<string | number>): string {
  const s = items.map(String);
  if (s.length <= 1) return s.join("");
  return `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}

/** Links need this many people with page detail before their figures are compared. */
export const LINK_COMPARE_MIN_PEOPLE = 5;
/** And this many links must qualify. */
const LINK_COMPARE_MIN_LINKS = 3;
/** Reached-the-last-page share the leader must beat the runner-up by (percentage points / 100). */
const LINK_END_MARGIN = 0.1;
/** Typical time the leader must beat the runner-up by, as a ratio. */
const LINK_TYPICAL_MARGIN = 1.25;

/** Share ids whose Reached-the-last-page and typical-time figures earn bold; null when nothing clearly leads. */
export function linkLeaders(links: LinkRow[]): { end: string | null; typical: string | null } {
  const comparable = links.filter((l) => (l.peopleWithDetail ?? 0) >= LINK_COMPARE_MIN_PEOPLE);
  if (comparable.length < LINK_COMPARE_MIN_LINKS) return { end: null, typical: null };
  const endRate = (l: LinkRow) => (l.reachedEnd ?? 0) / (l.peopleWithDetail ?? 1);
  const byEnd = [...comparable].sort((a, b) => endRate(b) - endRate(a));
  const end = endRate(byEnd[0]) > 0 && endRate(byEnd[0]) - endRate(byEnd[1]) >= LINK_END_MARGIN - 1e-9 ? byEnd[0].shareId : null;
  const timed = comparable.filter((l) => l.medianTotalMs != null && l.medianTotalMs > 0);
  const byTypical = [...timed].sort((a, b) => (b.medianTotalMs ?? 0) - (a.medianTotalMs ?? 0));
  const typical =
    byTypical.length >= 2 && (byTypical[0].medianTotalMs ?? 0) >= (byTypical[1].medianTotalMs ?? 0) * LINK_TYPICAL_MARGIN
      ? byTypical[0].shareId
      : null;
  return { end, typical };
}

/** "3 under 2s · 2 jumped past", leaving out a zero part; null when both are zero. */
export function skippedBreakdown(passed: number, jumped: number, sep = " · "): string | null {
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} under 2s`);
  if (jumped > 0) parts.push(`${jumped} jumped past`);
  return parts.length > 0 ? parts.join(sep) : null;
}
