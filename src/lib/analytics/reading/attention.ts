import {
  ACTIVE_WINDOW_MS,
  ATTENTION_MAX_ROWS,
  HOT_DWELL_MIN_PEERS,
  HOT_DWELL_MULTIPLIER,
  HOT_READ_RATIO,
  NOT_OPENED_AFTER_MS,
  RETURN_GAP_MS,
} from "./constants";
import { formatGap } from "./format";
import { toMs } from "./normalize";
import { buildReadPairs, typicalFromPairs } from "./pageTable";
import type { AttentionRow, HotReason, LinkInput, Person } from "./types";

export type { AttentionRow, HotReason } from "./types";

/** Largest gap between the end of one visit and the start of a later one, when it is at least RETURN_GAP_MS. */
export function largestReturnGap(p: Person): number | null {
  const visits = p.visits.filter((v) => v.seen.length > 0).sort((a, b) => a.startedAtMs - b.startedAtMs);
  let minEnd = Infinity;
  let best: number | null = null;
  for (const v of visits) {
    if (Number.isFinite(minEnd)) {
      const gap = v.startedAtMs - minEnd;
      if (best === null || gap > best) best = gap;
    }
    minEnd = Math.min(minEnd, v.lastEventAtMs);
  }
  return best !== null && best >= RETURN_GAP_MS ? best : null;
}

/**
 * Hot reason per person key, always computed over the whole document's people in range so a link
 * filter never changes who is hot.
 */
export function computeHot(docPeople: Person[], P: number): Map<string, HotReason | null> {
  const out = new Map<string, HotReason | null>();
  const withDetail = docPeople.filter((p) => p.hasDetail);
  const pairs = buildReadPairs(withDetail);
  for (const p of docPeople) {
    out.set(p.key, p.hasDetail ? hotFor(p, P, pairs) : null);
  }
  return out;
}

function hotFor(p: Person, P: number, pairs: ReturnType<typeof buildReadPairs>): HotReason | null {
  const gap = largestReturnGap(p);
  if (gap !== null) return { kind: "returned", gapMs: gap };
  if (P >= 2 && p.readPages / P >= HOT_READ_RATIO) return { kind: "read_most", read: p.readPages, pageCount: P };
  const t = typicalFromPairs(pairs, p.key);
  if (t.people < HOT_DWELL_MIN_PEERS || t.ms === null || t.ms <= 0) return null;
  let bestPage = 0;
  let bestDwell = 0;
  p.cells.forEach((c, i) => {
    if (c.state !== "read" || c.ms < HOT_DWELL_MULTIPLIER * (t.ms as number)) return;
    if (c.ms > bestDwell) {
      bestDwell = c.ms;
      bestPage = i + 1;
    }
  });
  if (bestPage === 0) return null;
  // Multiply before dividing so ratios like 40000/4000 floor to 10.0, not 9.9.
  return { kind: "dwell", page: bestPage, ratio: Math.floor((bestDwell * 10) / t.ms) / 10 };
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
 * Needs-attention rows: active people, hot people, then links nobody has opened. The basic tier
 * gets only the link rows, since the others reveal per-person reading detail.
 */
export function buildAttention(a: {
  people: Person[];
  links: LinkInput[];
  openedShareIds: Set<string>;
  hotByKey: Map<string, HotReason | null>;
  now: number;
  tier: "basic" | "deep";
}): { rows: AttentionRow[]; more: number } {
  const candidates: AttentionRow[] = [];

  if (a.tier === "deep") {
    const activeKeys = new Set<string>();
    const active = a.people
      .filter((p) => p.hasDetail && p.lastEventAtMs !== null && p.lastEventAtMs >= a.now - ACTIVE_WINDOW_MS)
      .sort((x, y) => (y.lastEventAtMs as number) - (x.lastEventAtMs as number) || byKey(x, y));
    for (const p of active) {
      activeKeys.add(p.key);
      candidates.push({
        kind: "active",
        personId: p.personId,
        name: p.name,
        linkLabel: p.linkLabel,
        page: p.latestVisit?.exitPage ?? null,
        at: new Date(p.lastEventAtMs as number).toISOString(),
      });
    }
    const hot = a.people
      .filter((p) => !activeKeys.has(p.key) && a.hotByKey.get(p.key))
      .sort((x, y) => y.lastSeenMs - x.lastSeenMs || byKey(x, y));
    for (const p of hot) {
      candidates.push({ kind: "hot", personId: p.personId, name: p.name, linkLabel: p.linkLabel, reason: a.hotByKey.get(p.key) as HotReason });
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
  for (const { l, created } of notOpened) {
    candidates.push({ kind: "not_opened", shareId: l.shareId, linkLabel: l.label, sentAt: new Date(created).toISOString() });
  }

  const rows = candidates.slice(0, ATTENTION_MAX_ROWS);
  return { rows, more: candidates.length - rows.length };
}

/** Chip wording for a hot reason. */
export function hotReasonText(r: HotReason): string {
  switch (r.kind) {
    case "returned":
      return `Came back ${formatGap(r.gapMs)} later`;
    case "read_most":
      return `Stayed on ${r.read} of ${r.pageCount} pages`;
    case "dwell":
      return `Spent ${r.ratio.toFixed(1)}× the typical page time on page ${r.page}`;
  }
}
