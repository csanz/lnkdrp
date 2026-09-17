import { ACTIVE_WINDOW_MS, MAX_VISITS_LOADED, PERSON_VISITS_LIMIT, READ_MIN_MS } from "./constants";
import { buildAttention, computeHot, linkStatus } from "./attention";
import { toMs } from "./normalize";
import { calloutGateText, computeCallouts, computePageTable, median } from "./pageTable";
import { pageMetaFromDoc, type DocPagesInput } from "./pageLabels";
import { buildPeople } from "./people";
import { buildVerdict } from "./verdict";
import {
  BASIC_LINK_KEYS,
  BASIC_READING_KEYS,
  type HotReason,
  type LinkInput,
  type LinkRow,
  type MatrixRow,
  type Person,
  type PersonResponse,
  type ReadingCore,
  type ReadingResponse,
  type ReadingTier,
  type ViewRowInput,
  type VisitInput,
} from "./types";

const MAX_INFERRED_PAGES = 500;

function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function maxOrNull(xs: Iterable<number>): number | null {
  let best: number | null = null;
  for (const x of xs) if (Number.isFinite(x) && (best === null || x > best)) best = x;
  return best;
}

function inferPageCount(visits: VisitInput[]): number {
  let max = 0;
  const consider = (v: unknown) => {
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v > max) max = v;
  };
  for (const v of visits) {
    for (const p of v.pagesSeen ?? []) consider(p);
    for (const ev of v.pageEvents ?? []) consider(ev?.pageNumber);
  }
  return Math.min(max, MAX_INFERRED_PAGES);
}

/** Everything the reading endpoints derive from one load: people, hot reasons and the doc-scope page table. */
export function buildReadingCore(input: {
  rows: ViewRowInput[];
  visits: VisitInput[];
  links: LinkInput[];
  lastOpenedRows: Array<{ shareId: string; lastMs: number }>;
  doc: DocPagesInput;
  completedUploads: number;
  now: number;
}): ReadingCore {
  const slideCount = Array.isArray(input.doc.slideNodes) ? input.doc.slideNodes.length : 0;
  const P = slideCount > 0 ? slideCount : inferPageCount(input.visits);
  const meta = pageMetaFromDoc(input.doc, P);
  const { people, unmatchedVisits, droppedEvents } = buildPeople(input.rows, input.visits, input.links, P, input.now);
  const lastOpenedByShareId = new Map<string, number>();
  for (const r of input.lastOpenedRows) {
    if (!r || typeof r.lastMs !== "number" || !Number.isFinite(r.lastMs)) continue;
    const prev = lastOpenedByShareId.get(r.shareId);
    if (prev === undefined || r.lastMs > prev) lastOpenedByShareId.set(r.shareId, r.lastMs);
  }
  return {
    P,
    meta,
    links: input.links,
    people,
    lastOpenedByShareId,
    hotByKey: computeHot(people, P),
    docPages: computePageTable(
      people.filter((p) => p.hasDetail),
      P,
      meta,
    ),
    multipleVersions: input.completedUploads > 1,
    truncated: input.visits.length >= MAX_VISITS_LOADED,
    droppedEvents,
    unmatchedVisits,
  };
}

function medianTotalMs(people: Person[]): number | null {
  return median(people.filter((p) => p.hasDetail && p.totalMs > 0).map((p) => p.totalMs));
}

function compareLinkRows(a: LinkRow, b: LinkRow): number {
  if (a.people !== b.people) return b.people - a.people;
  const nullsLast = (x: string | null, y: string | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? 1 : -1);
  return nullsLast(a.lastOpenedAt, b.lastOpenedAt) || nullsLast(a.createdAt, b.createdAt) || (a.shareId < b.shareId ? -1 : a.shareId > b.shareId ? 1 : 0);
}

function buildLinkRows(core: ReadingCore, tier: ReadingTier, now: number): LinkRow[] {
  const byLink = new Map<string, Person[]>();
  for (const p of core.people) {
    const list = byLink.get(p.shareId) ?? [];
    list.push(p);
    byLink.set(p.shareId, list);
  }
  const known = new Set(core.links.map((l) => l.shareId));

  const row = (base: Omit<LinkRow, "people" | "lastOpenedAt" | "everOpened" | "lastOpenedAtAllTime">): LinkRow => {
    const people = byLink.get(base.shareId) ?? [];
    const inRange = maxOrNull(people.map((p) => p.lastSeenMs));
    const mapped = core.lastOpenedByShareId.get(base.shareId);
    // All-time can never be earlier than activity inside the range; guard against a stale aggregate.
    const allTime = maxOrNull([...(mapped === undefined ? [] : [mapped]), ...(inRange === null ? [] : [inRange])]);
    const out: LinkRow = {
      ...base,
      people: people.length,
      lastOpenedAt: iso(inRange),
      everOpened: allTime !== null,
      lastOpenedAtAllTime: iso(allTime),
    };
    if (tier === "deep") {
      out.peopleWithDetail = people.filter((p) => p.hasDetail).length;
      out.reachedEnd = people.filter((p) => p.hasDetail && p.maxPage === core.P).length;
      out.medianTotalMs = medianTotalMs(people);
    }
    return out;
  };

  const rows: LinkRow[] = [];
  for (const l of core.links) {
    if (l.archivedAt && !(byLink.get(l.shareId)?.length)) continue;
    const created = toMs(l.createdDate);
    rows.push(
      row({ shareId: l.shareId, label: l.label, isDefault: Boolean(l.isDefault), status: linkStatus(l, now), createdAt: iso(created) }),
    );
  }
  for (const shareId of byLink.keys()) {
    if (known.has(shareId)) continue;
    rows.push(row({ shareId, label: "Deleted link", isDefault: false, status: "deleted", createdAt: null }));
  }
  return rows.sort(compareLinkRows);
}

/** Response for `/pages`: scope counts and links for both tiers, page and person detail for deep only. */
export function buildReadingResponse(
  core: ReadingCore,
  a: { tier: ReadingTier; days: number; daysLimit: number | null; shareId: string | null; matrixLimit: number; now: number },
): ReadingResponse {
  const scoped = a.shareId ? core.people.filter((p) => p.shareId === a.shareId) : core.people;
  const allTime = a.shareId
    ? maxOrNull([
        ...(core.lastOpenedByShareId.has(a.shareId) ? [core.lastOpenedByShareId.get(a.shareId) as number] : []),
        ...scoped.map((p) => p.lastSeenMs),
      ])
    : maxOrNull([...core.lastOpenedByShareId.values(), ...scoped.map((p) => p.lastSeenMs)]);
  const opened = new Set<string>([...core.lastOpenedByShareId.keys(), ...core.people.map((p) => p.shareId)]);
  const scopeLinks = a.shareId ? core.links.filter((l) => l.shareId === a.shareId) : core.links;

  const base = {
    ok: true as const,
    tier: a.tier,
    days: a.days,
    daysLimit: a.daysLimit,
    shareId: a.shareId,
    generatedAt: new Date(a.now).toISOString(),
    people: scoped.length,
    totalMs: scoped.reduce((s, p) => s + p.totalMs, 0),
    lastOpenedAt: iso(maxOrNull(scoped.map((p) => p.lastSeenMs))),
    everOpened: allTime !== null,
    lastOpenedAtAllTime: iso(allTime),
    links: buildLinkRows(core, a.tier, a.now),
    attention: buildAttention({ people: scoped, links: scopeLinks, openedShareIds: opened, hotByKey: core.hotByKey, now: a.now, tier: a.tier }),
  };

  if (a.tier === "basic") return toBasicReading(base);

  const detail = scoped.filter((p) => p.hasDetail);
  const N = detail.length;
  const pages = computePageTable(detail, core.P, core.meta);
  return {
    ...base,
    pageCount: core.P,
    peopleWithDetail: N,
    multipleVersions: core.multipleVersions,
    pages,
    callouts: computeCallouts(pages, N, core.P),
    calloutGate: calloutGateText(scoped.length, N),
    matrix: {
      rows: detail.slice(0, a.matrixLimit).map((p) => buildMatrixRow(p, core.P, a.now, core.hotByKey)),
      total: N,
      limit: a.matrixLimit,
    },
    totals: { reachedEnd: detail.filter((p) => p.maxPage === core.P).length, medianTotalMs: medianTotalMs(scoped) },
    coverage: { truncated: core.truncated, droppedEvents: core.droppedEvents, unmatchedVisits: core.unmatchedVisits },
  };
}

/**
 * Whitelist copy of a basic-built response. Throws when handed deep output, so a Free response can
 * never carry per-person or per-page detail by accident.
 */
export function toBasicReading(r: ReadingResponse): ReadingResponse {
  if (r.tier !== "basic" || r.attention.rows.some((row) => row.kind !== "not_opened")) {
    throw new Error("toBasicReading: expected a basic-built response");
  }
  const out: Record<string, unknown> = {};
  for (const k of BASIC_READING_KEYS) out[k] = r[k];
  out.links = r.links.map((l) => {
    const link: Record<string, unknown> = {};
    for (const k of BASIC_LINK_KEYS) link[k] = l[k];
    return link;
  });
  return out as ReadingResponse;
}

/** One ReadingMatrix row. */
export function buildMatrixRow(p: Person, P: number, now: number, hotByKey: Map<string, HotReason | null>): MatrixRow {
  return {
    personId: p.personId,
    name: p.name,
    source: p.source,
    email: p.email,
    shareId: p.shareId,
    linkLabel: p.linkLabel,
    lastSeen: new Date(p.lastSeenMs).toISOString(),
    totalMs: p.totalMs,
    reachedCount: p.reachedCount,
    readPages: p.readPages,
    maxPage: p.maxPage,
    exitPage: p.exitPage,
    activeNow: p.lastEventAtMs !== null && p.lastEventAtMs >= now - ACTIVE_WINDOW_MS,
    hot: hotByKey.get(p.key) ?? null,
    cells: p.cells.slice(0, P).map((c) => ({ ms: c.ms, state: c.state, revisit: c.revisit })),
  };
}

/** Response for `/pages/person`: verdict, facts, page bars and visits for one person. */
export function buildPersonResponse(core: ReadingCore, person: Person, a: { days: number; now: number }): PersonResponse {
  const labelByPage = new Map(core.meta.map((m) => [m.page, m.label]));
  const verdict = buildVerdict(person, core.P, (page) => labelByPage.get(page) ?? null);

  const pages = core.meta.map((m) => {
    const cell = person.cells[m.page - 1];
    return {
      page: m.page,
      label: m.label,
      thumbUrl: m.thumbUrl,
      ms: cell?.ms ?? 0,
      state: cell?.state ?? ("unreached" as const),
      revisits: person.revisitsByPage[m.page - 1] ?? 0,
      typicalMs: core.docPages[m.page - 1]?.typicalMs ?? null,
      leftHere: person.exitPage === m.page,
    };
  });

  const ordered = [...person.visits].sort(
    (x, y) => y.startedAtMs - x.startedAtMs || y.lastEventAtMs - x.lastEventAtMs || (x.visitId < y.visitId ? 1 : x.visitId > y.visitId ? -1 : 0),
  );
  const shown = ordered.slice(0, PERSON_VISITS_LIMIT);

  return {
    ok: true,
    days: a.days,
    pageCount: core.P,
    multipleVersions: core.multipleVersions,
    person: {
      personId: person.personId,
      name: person.name,
      source: person.source,
      email: person.email,
      shareId: person.shareId,
      linkLabel: person.linkLabel,
      isDefaultLink: person.isDefaultLink,
      firstSeen: new Date(person.firstSeenMs).toISOString(),
      lastSeen: new Date(person.lastSeenMs).toISOString(),
      downloads: person.downloads,
      hot: core.hotByKey.get(person.key) ?? null,
      activeNow: person.lastEventAtMs !== null && person.lastEventAtMs >= a.now - ACTIVE_WINDOW_MS,
    },
    verdict,
    facts: {
      visits: person.visits.length,
      totalMs: person.totalMs,
      reachedCount: person.reachedCount,
      maxPage: person.maxPage,
      exitPage: person.exitPage,
    },
    pages,
    visits: shown.map((v) => ({
      visitId: v.visitId,
      startedAt: new Date(v.startedAtMs).toISOString(),
      endedAt: new Date(v.lastEventAtMs).toISOString(),
      totalMs: v.timeSpentMs,
      timed: v.timed,
      exitPage: v.exitPage,
      exitInferred: v.exitInferred,
      stops: v.stops.map((s) => ({ page: s.page, ms: s.ms, revisit: s.revisit })),
      seen: v.seen,
      passedPages: v.timed ? v.seen.filter((page) => (v.dwellByPage[page - 1] ?? 0) < READ_MIN_MS) : [],
    })),
    more: { visits: ordered.length - shown.length },
  };
}
