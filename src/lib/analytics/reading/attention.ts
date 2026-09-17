import {
  ACTIVE_WINDOW_MS,
  ATTENTION_LIST_MAX,
  CALLOUT_MIN_PEOPLE,
  HOT_DWELL_MIN_PEERS,
  HOT_DWELL_MULTIPLIER,
  HOT_MAX_SHARE,
  HOT_MIN_KEEP,
  HOT_READ_RATIO,
  NOT_OPENED_AFTER_MS,
  RETURN_GAP_MS,
} from "./constants";
import { dwellRatio, formatDwell, formatReturnGap } from "./format";
import { toMs } from "./normalize";
import { buildReadPairs, computePageTable, typicalFromPairs } from "./pageTable";
import type { AttentionRow, HotReason, LinkInput, PageRow, Person } from "./types";

export type { AttentionRow, HotReason } from "./types";

export type ReturnGap = { gapMs: number; fromMs: number; toMs: number };

/**
 * Largest gap between the end of one visit and the start of a later one, when it is at least
 * RETURN_GAP_MS, with both ends: `fromMs` the earlier visit's last activity, `toMs` the later start.
 */
export function largestReturn(p: Person): ReturnGap | null {
  const visits = p.visits.filter((v) => v.seen.length > 0).sort((a, b) => a.startedAtMs - b.startedAtMs);
  let minEnd = Infinity;
  let best: ReturnGap | null = null;
  for (const v of visits) {
    if (Number.isFinite(minEnd)) {
      const gap = v.startedAtMs - minEnd;
      if (best === null || gap > best.gapMs) best = { gapMs: gap, fromMs: minEnd, toMs: v.startedAtMs };
    }
    minEnd = Math.min(minEnd, v.lastEventAtMs);
  }
  return best !== null && best.gapMs >= RETURN_GAP_MS ? best : null;
}

/** largestReturn's gap alone. */
export function largestReturnGap(p: Person): number | null {
  return largestReturn(p)?.gapMs ?? null;
}

/** Scores within this share of each other are a tie band: the hot cap never splits one. */
const HOT_TIE_SHARE = 0.9;

type HotEntry = { person: Person; reason: HotReason };

/**
 * Hot reason per person key, always computed over the whole document's people in range so a link
 * filter never changes who is hot. Only the strongest max(HOT_MIN_KEEP, HOT_MAX_SHARE of people
 * with detail) stay hot, so the flag keeps meaning something on a busy document; the cut is widened
 * to everyone within 10% of the last kept score, and one long-page person is always kept when any
 * qualifies, so near-identical readers and one-page standouts are not dropped arbitrarily.
 */
export function computeHot(docPeople: Person[], P: number): Map<string, HotReason | null> {
  const out = new Map<string, HotReason | null>();
  const withDetail = docPeople.filter((p) => p.hasDetail);
  const pairs = buildReadPairs(withDetail);
  const pages = computePageTable(withDetail, P, []);
  const totals = medianTotalsExcluding(withDetail);
  const hot: HotEntry[] = [];
  for (const p of docPeople) {
    out.set(p.key, null);
    const reason = p.hasDetail ? hotFor(p, P, pairs, pages, withDetail.length >= 3 ? totals(p.key) : null) : null;
    if (reason) hot.push({ person: p, reason });
  }
  hot.sort(compareHot);
  let n = Math.min(hot.length, Math.max(HOT_MIN_KEEP, Math.ceil(HOT_MAX_SHARE * withDetail.length)));
  const last = n > 0 ? hot[n - 1] : null;
  const lastScore = last ? hotScore(last) : null;
  if (last && lastScore !== null) {
    while (n < hot.length && hot[n].reason.kind === last.reason.kind && (hotScore(hot[n]) as number) >= HOT_TIE_SHARE * lastScore) n += 1;
  }
  const kept = hot.slice(0, n);
  if (!kept.some((h) => h.reason.kind === "dwell")) {
    const dwell = hot.find((h) => h.reason.kind === "dwell");
    if (dwell) kept.push(dwell);
  }
  for (const h of kept) out.set(h.person.key, h.reason);
  return out;
}

const HOT_KIND_RANK: Record<HotReason["kind"], number> = { returned: 0, read_most: 1, dwell: 2 };

function dwellScore(r: Extract<HotReason, { kind: "dwell" }>): number {
  return r.pageRatio ?? r.ratio;
}

/** Strength within a kind: total time for read_most, ratio for dwell; returners have none. */
function hotScore(h: HotEntry): number | null {
  if (h.reason.kind === "read_most") return h.person.totalMs;
  if (h.reason.kind === "dwell") return dwellScore(h.reason);
  return null;
}

/**
 * compareHot order, then within each tie band (same kind, score within 10% of the band's top)
 * people with a name or email ahead of anonymous ones, since those are the people an owner can reach.
 */
export function rankHot<T extends HotEntry>(entries: T[]): T[] {
  const sorted = [...entries].sort(compareHot);
  const out: T[] = [];
  for (let i = 0; i < sorted.length; ) {
    const top = hotScore(sorted[i]);
    let j = i + 1;
    if (top !== null) {
      while (j < sorted.length && sorted[j].reason.kind === sorted[i].reason.kind && (hotScore(sorted[j]) as number) >= HOT_TIE_SHARE * top) j += 1;
    }
    const band = sorted.slice(i, j);
    out.push(...band.filter((h) => h.person.source !== "anonymous"), ...band.filter((h) => h.person.source === "anonymous"));
    i = j;
  }
  return out;
}

/**
 * Strongest hot person first: returners (latest first), then people who stayed on most pages (most
 * time), then one long page (highest ratio, against the page's own typical time when it has one).
 * Someone who stayed on nearly every page outranks one long stop, so the cap never drops them for it.
 */
export function compareHot(a: HotEntry, b: HotEntry): number {
  const kind = HOT_KIND_RANK[a.reason.kind] - HOT_KIND_RANK[b.reason.kind];
  if (kind !== 0) return kind;
  let d = 0;
  if (a.reason.kind === "dwell" && b.reason.kind === "dwell") d = dwellScore(b.reason) - dwellScore(a.reason);
  else if (a.reason.kind === "read_most") d = b.person.totalMs - a.person.totalMs;
  return d || b.person.lastSeenMs - a.person.lastSeenMs || byKey(a.person, b.person);
}

/** Median person total over everyone but one key, in O(1) per lookup after one sort. */
function medianTotalsExcluding(people: Person[]): (key: string) => number | null {
  const sorted = people.map((p) => ({ key: p.key, ms: p.totalMs })).sort((a, b) => a.ms - b.ms);
  const indexByKey = new Map(sorted.map((x, i) => [x.key, i]));
  return (key) => {
    const skip = indexByKey.get(key);
    const n = skip === undefined ? sorted.length : sorted.length - 1;
    if (n <= 0) return null;
    const at = (j: number) => sorted[skip !== undefined && j >= skip ? j + 1 : j].ms;
    const mid = Math.floor(n / 2);
    return n % 2 === 1 ? at(mid) : Math.floor((at(mid - 1) + at(mid)) / 2);
  };
}

/**
 * True when page 1's stayed time was summed over more than one visit: someone who lands on the cover
 * each time they come back has not lingered on it, so it never counts as their standout page.
 */
export function coverSummedAcrossVisits(p: Person): boolean {
  return p.visits.filter((v) => (v.dwellByPage[0] ?? 0) > 0).length > 1;
}

function hotFor(
  p: Person,
  P: number,
  pairs: ReturnType<typeof buildReadPairs>,
  pages: PageRow[],
  othersMedianTotalMs: number | null,
): HotReason | null {
  const ret = largestReturn(p);
  if (ret !== null) return { kind: "returned", gapMs: ret.gapMs, fromAt: new Date(ret.fromMs).toISOString(), toAt: new Date(ret.toMs).toISOString() };
  if (
    P >= 2 &&
    p.readPages / P >= HOT_READ_RATIO &&
    p.maxPage === P &&
    (othersMedianTotalMs === null || p.totalMs >= 2 * othersMedianTotalMs)
  ) {
    return { kind: "read_most", read: p.readPages, pageCount: P, totalMs: p.totalMs };
  }
  const t = typicalFromPairs(pairs, p.key);
  if (t.ms === null || t.ms <= 0) return null;
  const docTypicalMs = t.ms;
  const docRuleHolds = t.people >= HOT_DWELL_MIN_PEERS;
  const skipCover = coverSummedAcrossVisits(p);
  const candidates: Array<Extract<HotReason, { kind: "dwell" }>> = [];
  for (let i = 0; i < p.cells.length; i++) {
    const c = p.cells[i];
    if (c.state !== "read" || (i === 0 && skipCover)) continue;
    const page = i + 1;
    // A page with a typical time in the page table is judged against it, the same figure the table
    // and reader sheet show; other pages fall back to the doc's typical page time. A page-level ratio
    // is only stated once enough people stayed on the page for the highlights.
    const row = pages[i];
    const typical = row && row.typicalMs !== null && row.typicalMs > 0 ? row.typicalMs : null;
    const qualifies = typical !== null ? c.ms >= HOT_DWELL_MULTIPLIER * typical : docRuleHolds && c.ms >= HOT_DWELL_MULTIPLIER * docTypicalMs;
    if (!qualifies) continue;
    const pageTypicalMs = typical !== null && row.readCount >= CALLOUT_MIN_PEOPLE ? typical : null;
    const candidate = {
      kind: "dwell" as const,
      page,
      ms: c.ms,
      ratio: dwellRatio(c.ms, docTypicalMs),
      pageTypicalMs,
      pageRatio: pageTypicalMs !== null ? dwellRatio(c.ms, pageTypicalMs) : null,
      docTypicalMs,
    };
    candidates.push(candidate);
  }
  return pickStandout(candidates, dwellScore);
}

/**
 * The strongest standout page: the highest ratio, except that among pages within 10% of it the one
 * held longest wins (2m 50s at 6.5× says more than 34s at 7.2×). Earlier pages win exact ties.
 */
export function pickStandout<T extends { ms: number }>(candidates: T[], ratio: (c: T) => number): T | null {
  if (candidates.length === 0) return null;
  const top = Math.max(...candidates.map(ratio));
  let best: T | null = null;
  for (const c of candidates) if (ratio(c) >= HOT_TIE_SHARE * top && (!best || c.ms > best.ms)) best = c;
  return best;
}

/** Link state at `now`: archived wins over disabled, disabled over expired. */
export function linkStatus(l: LinkInput, now: number): "active" | "disabled" | "expired" | "archived" {
  if (l.archivedAt) return "archived";
  if (!l.enabled) return "disabled";
  const exp = toMs(l.expiresAt);
  if (exp !== null && exp <= now) return "expired";
  return "active";
}

function byKey(a: Person, b: Person): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Needs-attention rows: active people, then hot people by strength (together capped at
 * ATTENTION_LIST_MAX, `more` counting the hidden ones), then every link nobody has opened, oldest
 * first and never capped, so the page can group them in one row. The basic tier gets only the link
 * rows, since the others reveal per-person reading detail.
 */
export function buildAttention(a: {
  people: Person[];
  links: LinkInput[];
  openedShareIds: Set<string>;
  hotByKey: Map<string, HotReason | null>;
  now: number;
  tier: "basic" | "deep";
}): { rows: AttentionRow[]; more: number } {
  const people: AttentionRow[] = [];
  const hotRows: AttentionRow[] = [];

  if (a.tier === "deep") {
    const activeKeys = new Set<string>();
    const active = a.people
      .filter((p) => p.hasDetail && p.lastEventAtMs !== null && p.lastEventAtMs >= a.now - ACTIVE_WINDOW_MS)
      .sort((x, y) => (y.lastEventAtMs as number) - (x.lastEventAtMs as number) || byKey(x, y));
    for (const p of active) {
      activeKeys.add(p.key);
      people.push({
        kind: "active",
        personId: p.personId,
        name: p.name,
        linkLabel: p.linkLabel,
        page: p.latestVisit?.exitPage ?? null,
        at: new Date(p.lastEventAtMs as number).toISOString(),
        totalMs: p.totalMs,
        exitPage: p.exitPage,
      });
    }
    const hot = rankHot(
      a.people.filter((p) => !activeKeys.has(p.key) && a.hotByKey.get(p.key)).map((person) => ({ person, reason: a.hotByKey.get(person.key) as HotReason })),
    );
    for (const { person: p, reason } of hot) {
      hotRows.push({
        kind: "hot",
        personId: p.personId,
        name: p.name,
        linkLabel: p.linkLabel,
        reason,
        lastSeen: new Date(p.lastSeenMs).toISOString(),
        totalMs: p.totalMs,
        exitPage: p.exitPage,
      });
    }
  }

  const nonArchived = a.links.filter((l) => !l.archivedAt);
  const cutoff = a.now - NOT_OPENED_AFTER_MS;
  const notOpened = a.links
    .filter((l) => {
      if (linkStatus(l, a.now) !== "active") return false;
      const created = toMs(l.createdDate);
      if (created === null || created > cutoff) return false;
      if (a.openedShareIds.has(l.shareId)) return false;
      return !l.isDefault || (nonArchived.length === 1 && nonArchived[0].shareId === l.shareId);
    })
    .map((l) => ({ l, created: toMs(l.createdDate) as number }))
    .sort((x, y) => x.created - y.created || (x.l.shareId < y.l.shareId ? -1 : x.l.shareId > y.l.shareId ? 1 : 0));
  const notOpenedRows: AttentionRow[] = notOpened.map(({ l, created }) => ({
    kind: "not_opened",
    shareId: l.shareId,
    linkLabel: l.label,
    sentAt: new Date(created).toISOString(),
  }));

  const personRows = [...people, ...hotRows];
  const shown = personRows.slice(0, ATTENTION_LIST_MAX);
  return { rows: [...shown, ...notOpenedRows], more: personRows.length - shown.length };
}

/** Chip wording for a hot reason; `tz` sets the calendar for "the next day" (default: this runtime's zone). */
export function hotReasonText(r: HotReason, tz?: string): string {
  switch (r.kind) {
    case "returned":
      return `Came back ${formatReturnGap(Date.parse(r.fromAt), Date.parse(r.toAt), tz)}`;
    case "read_most":
      return `Stayed on ${r.read} of ${r.pageCount} pages · ${formatDwell(r.totalMs)}`;
    case "dwell":
      return r.pageRatio !== null && r.pageTypicalMs !== null
        ? `Spent ${formatDwell(r.ms)} on page ${r.page}, ${r.pageRatio.toFixed(1)}× its typical ${formatDwell(r.pageTypicalMs)}`
        : `Spent ${formatDwell(r.ms)} on page ${r.page}; most pages take about ${formatDwell(r.docTypicalMs)}`;
  }
}
