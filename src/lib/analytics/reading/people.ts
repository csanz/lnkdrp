import { READ_MIN_MS } from "./constants";
import { encodePersonId } from "./identity";
import { normalizeVisit, toMs } from "./normalize";
import type { Cell, IdentitySource, LinkInput, NormalizedVisit, Person, ViewRowInput, VisitInput } from "./types";

export type { Cell, CellState, IdentitySource, Person } from "./types";

const DELETED_LINK_LABEL = "Deleted link";

function nonEmpty(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t ? t : null;
}

function rowKey(r: ViewRowInput): { key: string; kind: "a" | "u"; id: string } {
  const uid = nonEmpty(r.viewerUserId);
  if (uid) return { key: `${r.shareId}|u:${uid}`, kind: "u", id: uid };
  return { key: `${r.shareId}|a:${r.botIdHash}`, kind: "a", id: r.botIdHash };
}

function rowLastSeen(r: ViewRowInput): number {
  return toMs(r.lastViewedAt) ?? toMs(r.updatedDate) ?? 0;
}

type Group = {
  key: string;
  kind: "a" | "u";
  id: string;
  shareId: string;
  rows: ViewRowInput[];
  visits: NormalizedVisit[];
};

/**
 * Group ShareView rows into people (one per link + viewer key, the same basis as `/shareviews`
 * viewerCount), attach each visit through its (shareId, botIdHash) row, and derive per-page cells.
 * Visits with no matching row are counted in `unmatchedVisits` and left out of every figure.
 */
export function buildPeople(
  rows: ViewRowInput[],
  visits: VisitInput[],
  links: LinkInput[],
  P: number,
  now: number,
): { people: Person[]; unmatchedVisits: number; droppedEvents: number } {
  void now;
  const linkById = new Map(links.map((l) => [l.shareId, l]));
  const groups = new Map<string, Group>();
  const rowByShareBot = new Map<string, string>();

  for (const r of rows) {
    const { key, kind, id } = rowKey(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, kind, id, shareId: r.shareId, rows: [], visits: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
    rowByShareBot.set(`${r.shareId}|${r.botIdHash}`, key);
  }

  let unmatchedVisits = 0;
  let droppedEvents = 0;
  for (const v of visits) {
    const key = rowByShareBot.get(`${v.shareId}|${v.botIdHash}`);
    const g = key ? groups.get(key) : undefined;
    if (!g) {
      unmatchedVisits += 1;
      continue;
    }
    const nv = normalizeVisit(v, P);
    droppedEvents += nv.droppedEvents;
    g.visits.push(nv);
  }

  const people: Person[] = [];
  for (const g of groups.values()) people.push(personFromGroup(g, linkById.get(g.shareId) ?? null, P));

  assignAnonymousLabels(people);
  people.sort((a, b) => b.lastSeenMs - a.lastSeenMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { people, unmatchedVisits, droppedEvents };
}

function personFromGroup(g: Group, link: LinkInput | null, P: number): Person {
  let identityRow = g.rows[0];
  let firstSeenMs = Infinity;
  let lastSeenMs = -Infinity;
  let downloads = 0;
  for (const r of g.rows) {
    const seenAt = rowLastSeen(r);
    if (seenAt > rowLastSeen(identityRow)) identityRow = r;
    lastSeenMs = Math.max(lastSeenMs, seenAt);
    firstSeenMs = Math.min(firstSeenMs, toMs(r.createdDate) ?? seenAt);
    downloads += typeof r.downloads === "number" && Number.isFinite(r.downloads) ? r.downloads : 0;
  }

  let source: IdentitySource;
  let name: string | null;
  let email: string | null;
  if (nonEmpty(identityRow.viewerUserId)) {
    source = "signed_in";
    name = nonEmpty(identityRow.viewerName);
    email = nonEmpty(identityRow.viewerEmailSnapshot) ?? nonEmpty(identityRow.viewerEmail);
  } else {
    name = nonEmpty(identityRow.viewerName);
    email = nonEmpty(identityRow.viewerEmail) ?? nonEmpty(identityRow.viewerEmailSnapshot);
    source = name || email ? "introduced" : "anonymous";
  }

  const size = Math.max(0, P);
  const dwellByPage = new Array<number>(size).fill(0);
  const revisitsByPage = new Array<number>(size).fill(0);
  const seenSet = new Set<number>();
  let timed = false;
  let totalMs = 0;
  let lastEventAtMs: number | null = null;
  let latestVisit: NormalizedVisit | null = null;
  for (const v of g.visits) {
    totalMs += v.timeSpentMs;
    timed = timed || v.timed;
    lastEventAtMs = lastEventAtMs === null ? v.lastEventAtMs : Math.max(lastEventAtMs, v.lastEventAtMs);
    for (const p of v.seen) seenSet.add(p);
    for (let i = 0; i < size; i++) {
      dwellByPage[i] += v.dwellByPage[i] ?? 0;
      revisitsByPage[i] += Math.max(0, (v.stopsByPage[i] ?? 0) - 1);
    }
    if (v.seen.length > 0 && (latestVisit === null || isLater(v, latestVisit))) latestVisit = v;
  }
  const seen = [...seenSet].sort((a, b) => a - b);

  const cells: Cell[] = [];
  let readPages = 0;
  for (let i = 0; i < size; i++) {
    const page = i + 1;
    const ms = dwellByPage[i];
    const state = !seenSet.has(page) ? "unreached" : !timed ? "unknown" : ms >= READ_MIN_MS ? "read" : "passed";
    if (state === "read") readPages += 1;
    cells.push({ ms, state, revisit: revisitsByPage[i] > 0 });
  }

  const linkLabel = link ? link.label : DELETED_LINK_LABEL;
  return {
    personId: encodePersonId({ shareId: g.shareId, kind: g.kind, id: g.id }),
    key: g.key,
    shareId: g.shareId,
    linkLabel,
    isDefaultLink: link ? Boolean(link.isDefault) : false,
    // Anonymous fallbacks are filled in by assignAnonymousLabels once every person on the link is known.
    name: name ?? email ?? "",
    source,
    email,
    firstSeenMs: Number.isFinite(firstSeenMs) ? firstSeenMs : 0,
    lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : 0,
    downloads,
    visits: g.visits,
    hasDetail: seen.length > 0,
    timed,
    seen,
    maxPage: seen.length > 0 ? seen[seen.length - 1] : 0,
    reachedCount: seen.length,
    readPages,
    dwellByPage,
    revisitsByPage,
    totalMs,
    latestVisit,
    exitPage: latestVisit?.exitPage ?? null,
    lastEventAtMs,
    cells,
  };
}

function isLater(a: NormalizedVisit, b: NormalizedVisit): boolean {
  if (a.lastEventAtMs !== b.lastEventAtMs) return a.lastEventAtMs > b.lastEventAtMs;
  if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs > b.startedAtMs;
  return a.visitId > b.visitId;
}

function assignAnonymousLabels(people: Person[]): void {
  const byLink = new Map<string, Person[]>();
  for (const p of people) {
    if (p.name) continue;
    const list = byLink.get(p.shareId) ?? [];
    list.push(p);
    byLink.set(p.shareId, list);
  }
  for (const list of byLink.values()) {
    if (list.length === 1) {
      list[0].name = `Anonymous reader · ${list[0].linkLabel}`;
      continue;
    }
    list.sort((a, b) => a.firstSeenMs - b.firstSeenMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    list.forEach((p, i) => {
      p.name = `Anonymous reader ${i + 1} · ${p.linkLabel}`;
    });
  }
}
