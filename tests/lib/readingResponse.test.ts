/**
 * Response builders (spec §3.9): RESP1 doc and link scope, the basic whitelist, person responses,
 * and a seeded fuzz over the page-table identities.
 */
import { describe, expect, test } from "vitest";

import {
  ATTENTION_LIST_MAX,
  BASIC_LINK_KEYS,
  BASIC_READING_KEYS,
  HOT_MAX_SHARE,
  HOT_MIN_KEEP,
  buildPeopleSeries,
  buildPersonResponse,
  buildReadingCore,
  buildReadingResponse,
  calloutGateText,
  computeCallouts,
  hotReasonText,
  toBasicReading,
  type LinkInput,
  type ReadingResponse,
  type ViewRowInput,
  type VisitInput,
} from "@/lib/analytics/reading";

import {
  DAY,
  FLIPPER,
  L0,
  L1,
  LF1,
  LF2,
  NADIA,
  ORPHAN,
  PT1,
  PT1_NOW,
  RESP1,
  RESP1_CORE,
  RESP1_LAST_OPENED,
  T0,
  F1,
  coreOf,
  docOf,
  hex64,
  makeLink,
  personOf,
  personResponseF1,
  personResponseF6,
  personResponsePT1A,
  readingResponseBasicAT1,
  readingResponseDeepPT1,
} from "./fixtures/readingFixtures";

const iso = (ms: number) => new Date(ms).toISOString();
const F1_LABELLED = { fx: F1, doc: docOf(4, { 3: "team-who-is-building-it" }) };
const deepArgs = { tier: "deep" as const, days: 30, daysLimit: null, shareId: null, matrixLimit: 25, now: PT1_NOW };

describe("RESP1 doc scope, deep", () => {
  const r = buildReadingResponse(RESP1_CORE, deepArgs);

  test("top level", () => {
    expect(r.people).toBe(6);
    expect(r.totalMs).toBe(150300);
    expect(r.lastOpenedAt).toBe(iso(T0 + 3_300_000));
    expect(r.lastOpenedAtAllTime).toBe(iso(T0 + 3_300_000));
    expect(r.everOpened).toBe(true);
    expect(r.calloutGate).toBeNull();
    expect(r.peopleWithDetail).toBe(6);
    expect(r.pageCount).toBe(4);
    expect(r.coverage).toEqual({ truncated: false, droppedEvents: 0, unmatchedVisits: 0 });
  });

  test("links: deleted row, L0, L1, sums and all-time agreement", () => {
    const byId = new Map(r.links.map((l) => [l.shareId, l]));
    const z = byId.get(ORPHAN)!;
    expect(z).toMatchObject({ status: "deleted", label: "Deleted link", isDefault: false, createdAt: null, people: 1 });
    expect(z.lastOpenedAt).toBe(iso(T0));
    expect(z.lastOpenedAtAllTime).toBe(iso(T0));

    const l0 = byId.get(L0)!;
    expect(l0.people).toBe(5);
    expect(l0.lastOpenedAt).toBe(iso(T0 + 3_300_000));
    expect(l0.lastOpenedAtAllTime).toBe(iso(T0 + 3_300_000));
    expect(l0.peopleWithDetail).toBe(5);
    expect(l0.reachedEnd).toBe(2);

    const l1 = byId.get(L1)!;
    expect(l1).toMatchObject({ people: 0, everOpened: false, lastOpenedAtAllTime: null, lastOpenedAt: null });

    expect(r.links.reduce((s, l) => s + l.people, 0)).toBe(6);
    for (const l of r.links) {
      expect(l.everOpened).toBe(l.lastOpenedAtAllTime !== null);
      if (l.people > 0) expect(l.lastOpenedAt).toBe(l.lastOpenedAtAllTime);
    }
    expect(r.links[0].shareId).toBe(L0);
    expect(byId.get("shareL3old")?.status).toBe("disabled");
  });

  test("attention is built for the deep tier", () => {
    expect(r.attention.rows.map((x) => x.kind)).toEqual(["active", "hot", "not_opened"]);
  });

  test("basic key sets", () => {
    const b = buildReadingResponse(RESP1_CORE, { ...deepArgs, tier: "basic", days: 7, daysLimit: 7 });
    expect(Object.keys(b).sort()).toEqual([...BASIC_READING_KEYS].sort());
    const l1 = b.links.find((l) => l.shareId === L1)!;
    expect(Object.keys(l1).sort()).toEqual([...BASIC_LINK_KEYS].sort());
    for (const l of b.links) expect(Object.keys(l).sort()).toEqual([...BASIC_LINK_KEYS].sort());
    expect(b.totalMs).toBe(150300);
    expect(b.attention.rows.every((x) => x.kind === "not_opened")).toBe(true);
  });

  test("toBasicReading throws on deep input", () => {
    expect(() => toBasicReading(r)).toThrow("toBasicReading: expected a basic-built response");
    const disguised = { ...r, tier: "basic" as const };
    expect(() => toBasicReading(disguised)).toThrow("toBasicReading: expected a basic-built response");
  });

  test("L1 opened before the range: everOpened with all-time date, not in not_opened", () => {
    const core = coreOf(RESP1, { lastOpenedRows: [...RESP1_LAST_OPENED, { shareId: L1, lastMs: T0 - 40 * DAY }] });
    const r2 = buildReadingResponse(core, deepArgs);
    const l1 = r2.links.find((l) => l.shareId === L1)!;
    expect(l1.people).toBe(0);
    expect(l1.everOpened).toBe(true);
    expect(l1.lastOpenedAtAllTime).toBe(iso(T0 - 40 * DAY));
    expect(r2.attention.rows.some((x) => x.kind === "not_opened" && x.shareId === L1)).toBe(false);
  });

  test("link scope L0", () => {
    const s = buildReadingResponse(RESP1_CORE, { ...deepArgs, shareId: L0, matrixLimit: 2 });
    expect(s.people).toBe(5);
    expect(s.totalMs).toBe(145300);
    expect(s.everOpened).toBe(true);
    expect(s.matrix?.rows.map((m) => m.personId)).toEqual([PT1.keys[0], PT1.keys[4]].map((k) => RESP1_CORE.people.find((p) => p.key === k)!.personId));
    expect(s.matrix?.total).toBe(5);
    expect(s.matrix?.limit).toBe(2);
    expect(s.links.reduce((sum, l) => sum + l.people, 0)).toBe(6);
  });
});

describe("samples", () => {
  test("readingResponseDeepPT1", () => {
    const r = readingResponseDeepPT1;
    expect(r.tier).toBe("deep");
    expect(r.people).toBe(5);
    expect(r.totalMs).toBe(145300);
    expect(r.pages?.map((p) => p.typicalMs)).toEqual([4000, 30000, null, null]);
    expect(r.callouts).toEqual(computeCallouts(r.pages!, 5, 4));
    expect(r.matrix?.rows).toHaveLength(5);
    expect(r.matrix?.rows[0].activeNow).toBe(true);
    expect(r.matrix?.rows[0].exitPage).toBe(4);
    expect(r.totals).toEqual({ reachedEnd: 2, medianTotalMs: 24000 });
  });

  test("the sheet's page typical equals the page table's for every person and page", () => {
    const core = coreOf(RESP1, { lastOpenedRows: RESP1_LAST_OPENED });
    const table = buildReadingResponse(core, deepArgs).pages!;
    for (const p of core.people.filter((x) => x.hasDetail)) {
      const pr = buildPersonResponse(core, p, { days: 30, now: PT1_NOW });
      expect(pr.pages.map((pg) => pg.typicalMs)).toEqual(table.map((row) => row.typicalMs));
    }
  });

  test("readingResponseBasicAT1", () => {
    expect(Object.keys(readingResponseBasicAT1).sort()).toEqual([...BASIC_READING_KEYS].sort());
    expect(readingResponseBasicAT1.attention.rows).toHaveLength(1);
  });

  test("personResponseF1", () => {
    const r = personResponseF1;
    expect(r.verdict.text).toBe("Went through all 4 pages. Went back to page\u00a03.");
    expect(r.person.hot && hotReasonText(r.person.hot)).toBe("Stayed on 4 of 4 pages · 28s");
    expect(r.person.activeNow).toBe(false);
    expect(r.pages).toHaveLength(4);
    expect(r.pages.every((p) => p.typicalMs === null)).toBe(true);
    expect(r.pages.map((p) => p.leftHere)).toEqual([false, false, true, false]);
    expect(r.pages.map((p) => p.revisits)).toEqual([0, 1, 2, 0]);
    expect(r.visits).toHaveLength(1);
    expect(r.visits[0].exitPage).toBe(3);
    expect(r.visits[0].passedPages).toEqual([]);
    expect(r.facts).toEqual({ visits: 1, totalMs: 28729, reachedCount: 4, maxPage: 4, exitPage: 3, typicalTotalMs: null });
    expect(r.more.visits).toBe(0);
  });

  test("personResponseF6", () => {
    const r = personResponseF6;
    expect(r.person.hot).toEqual({ kind: "returned", gapMs: 70 * 3_600_000 - 50_000, fromAt: iso(T0 + 50_000), toAt: iso(T0 + 70 * 3_600_000) });
    expect(r.visits.map((v) => v.visitId)).toEqual(["f6-v2", "f6-v1"]);
    expect(r.visits[0].passedPages).toEqual([1]);
    expect(r.facts.totalMs).toBe(140000);
  });

  test("personResponsePT1A", () => {
    const r = personResponsePT1A;
    // The page table's figures, A included: page 1 from five people, page 2 from A, D and E.
    expect(r.pages.map((p) => p.typicalMs)).toEqual(readingResponseDeepPT1.pages!.map((p) => p.typicalMs));
    expect(r.pages.map((p) => p.typicalMs)).toEqual([4000, 30000, null, null]);
    expect(r.pages.map((p) => p.readCount)).toEqual([5, 3, 2, 2]);
    // A ratio only where five people stayed: A's 5s on page 1 against 4s.
    expect(r.pages.map((p) => p.ratio)).toEqual([1.2, null, null, null]);
    expect(r.person.activeNow).toBe(true);
    expect(r.facts.exitPage).toBe(4);
    // Everyone's totals, the KPI's median: 49000, 24000, 3000, 47800, 21500.
    expect(r.facts.typicalTotalMs).toBe(24000);
    expect(r.facts.typicalTotalMs).toBe(readingResponseDeepPT1.totals!.medianTotalMs);
  });
});

describe("person visits and exits", () => {
  test("stops carry passed steps where a turn landed without a timed stop", () => {
    const core = coreOf(FLIPPER);
    const r = buildPersonResponse(core, core.people[0], { days: 30, now: FLIPPER.now });
    expect(r.visits[0].stops).toEqual([
      { page: 1, ms: 4000, revisit: false, passed: false, untimed: false },
      { page: 11, ms: 6000, revisit: false, passed: false, untimed: false },
      { page: 12, ms: 0, revisit: false, passed: true, untimed: false },
      { page: 11, ms: 3000, revisit: true, passed: false, untimed: false },
      { page: 10, ms: 9000, revisit: false, passed: false, untimed: false },
    ]);
    expect(r.visits[0].stops.reduce((s, x) => s + x.ms, 0)).toBe(r.pages.reduce((s, p) => s + p.ms, 0));
  });

  test("a lost final turn onto the last page: exit page 12 is unknown and left here, with an untimed step at the end", () => {
    const core = coreOf(NADIA);
    const r = buildPersonResponse(core, core.people[0], { days: 30, now: NADIA.now });
    expect(r.verdict.text).toBe("Went through all 12 pages.");
    expect(r.facts.exitPage).toBe(12);
    expect(r.pages[11]).toMatchObject({ state: "unknown", leftHere: true, ms: 0 });
    expect(r.visits[0].stops.at(-1)).toEqual({ page: 12, ms: 0, revisit: false, passed: false, untimed: true });
    expect(r.visits[0].stops.filter((x) => x.passed)).toEqual([]);
    expect(r.visits[0].passedPages).toEqual([]);
    expect(r.visits[0].exitInferred).toBe(true);
  });

  test("LF1: steps end 6, 7, 8 untimed; passed pages and the page table leave the tail out", () => {
    const core = coreOf(LF1);
    const r = buildPersonResponse(core, core.people[0], { days: 30, now: LF1.now });
    const v = r.visits[0];
    expect(v.stops.map((x) => `${x.page}${x.untimed ? "u" : x.passed ? "p" : ""}`)).toEqual(["2", "3p", "5", "6u", "7u", "8u"]);
    expect(v.passedPages).toEqual([1, 3, 4]);
    expect(v.exitPage).toBe(8);
    expect(r.facts.exitPage).toBe(8);
    expect(r.pages.slice(5, 8).map((p) => [p.state, p.leftHere])).toEqual([
      ["unknown", false],
      ["unknown", false],
      ["unknown", true],
    ]);
    expect(r.verdict.coverage).toBe("Stopped at page\u00a08 of 12");

    const table = buildReadingResponse(core, { ...deepArgs, now: LF1.now }).pages!;
    expect(table.map((p) => p.passed)).toEqual([1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(table.map((p) => p.leftHere)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(table[6].reached).toBe(1);
  });

  test("LF2: the same tail with no later activity leaves on the turn's target", () => {
    const core = coreOf(LF2);
    const r = buildPersonResponse(core, core.people[0], { days: 30, now: LF2.now });
    expect(r.visits[0].stops.map((x) => `${x.page}${x.untimed ? "u" : x.passed ? "p" : ""}`)).toEqual(["2", "3p", "5", "6u", "7u", "8u"]);
    expect(r.pages.map((p) => p.leftHere).indexOf(true)).toBe(5);
    expect(r.pages[5].state).toBe("unknown");
  });

  test("labels: long label on page rows, role alone as the short label and in the verdict", () => {
    const core = coreOf(F1_LABELLED.fx, { doc: F1_LABELLED.doc });
    const r = buildPersonResponse(core, core.people[0], { days: 30, now: F1_LABELLED.fx.now });
    expect(r.pages[2]).toMatchObject({ label: "Team: Who is building it", shortLabel: "Team" });
    expect(r.verdict).toMatchObject({ behaviour: "Went back to page\u00a03 (Team)", page: 3 });
    const deep = buildReadingResponse(core, { ...deepArgs, now: F1_LABELLED.fx.now });
    expect(deep.pages![2]).toMatchObject({ label: "Team: Who is building it", shortLabel: "Team" });
  });

  test("anonymous numbers are on the matrix row and the person", () => {
    const m = readingResponseDeepPT1.matrix!.rows;
    expect(new Set(m.map((x) => x.name)).size).toBe(m.length);
    for (const row of m) expect(row.name).toBe(`Anonymous reader ${row.anonNumber}`);
    expect(personResponsePT1A.person.name).toBe(`Anonymous reader ${personResponsePT1A.person.anonNumber}`);
  });
});

describe("series", () => {
  test("buckets people by the local day of their last activity, zero-filled over the window", () => {
    const p = { ...personOf(PT1), lastSeenMs: Date.parse("2026-08-31T05:47:00.000Z") };
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const la = buildPeopleSeries([p], 7, now, "America/Los_Angeles");
    expect(la.map((x) => x.day)).toEqual(["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01"]);
    expect(la.find((x) => x.day === "2026-08-30")?.people).toBe(1);
    expect(la.reduce((s, x) => s + x.people, 0)).toBe(1);
    const utc = buildPeopleSeries([p], 7, now, "UTC");
    expect(utc[0].day).toBe("2026-08-26");
    expect(utc.find((x) => x.day === "2026-08-31")?.people).toBe(1);
  });

  test("both tiers carry series summing to people", () => {
    const deep = buildReadingResponse(RESP1_CORE, { ...deepArgs, tz: "America/New_York" });
    const basic = buildReadingResponse(RESP1_CORE, { ...deepArgs, tier: "basic", days: 7, daysLimit: 7 });
    for (const r of [deep, basic]) expect(r.series.reduce((s, x) => s + x.people, 0)).toBe(r.people);
    expect(deep.series).toHaveLength(31);
  });
});

describe("buildPersonResponse visit limit", () => {
  test("newest 50 visits, the rest counted", () => {
    const shareId = "manyVisits";
    const bot = hex64("many");
    const visits: VisitInput[] = Array.from({ length: 53 }, (_, i) => ({
      visitId: `v${String(i).padStart(3, "0")}`,
      shareId,
      botIdHash: bot,
      startedAt: new Date(T0 + i * 60_000),
      lastEventAt: new Date(T0 + i * 60_000 + 1000),
      timeSpentMs: 1000,
      pagesSeen: [1],
      pageEvents: [],
    }));
    const row: ViewRowInput = {
      shareId,
      botIdHash: bot,
      viewerUserId: null,
      viewerName: null,
      viewerEmail: null,
      viewerEmailSnapshot: null,
      createdDate: new Date(T0),
      lastViewedAt: new Date(T0 + 53 * 60_000),
      updatedDate: new Date(T0 + 53 * 60_000),
      downloads: 0,
    };
    const core = buildReadingCore({ rows: [row], visits, links: [], lastOpenedRows: [], doc: { slideNodes: [], pageSlugs: [] }, completedUploads: 2, now: T0 + DAY });
    expect(core.P).toBe(1);
    expect(core.multipleVersions).toBe(true);
    const r = buildPersonResponse(core, core.people[0], { days: 30, now: T0 + DAY });
    expect(r.visits).toHaveLength(50);
    expect(r.visits[0].visitId).toBe("v052");
    expect(r.more.visits).toBe(3);
    expect(r.facts.totalMs).toBe(53000);
  });
});

// ---------------------------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REASONS = ["turn", "hidden", "pagehide", "unmount", "heartbeat", "idle", null, undefined];
const READ_WORD = /\bread\b/i;

function randomSet(seed: number) {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const now = T0 + 30 * DAY;
  const P = int(1, 12);
  const links: LinkInput[] = Array.from({ length: int(1, 3) }, (_, i) =>
    makeLink({
      shareId: `fz${seed}l${i}`,
      label: `Link ${i}`,
      isDefault: i === 0,
      enabled: rnd() > 0.2,
      createdDate: new Date(now - int(1, 200) * 3_600_000),
      archivedAt: rnd() < 0.1 ? new Date(now) : null,
    }),
  );
  const shareIds = [...links.map((l) => l.shareId), `fz${seed}gone`];
  const rows: ViewRowInput[] = [];
  const visits: VisitInput[] = [];
  const nPeople = int(0, 14);
  for (let i = 0; i < nPeople; i++) {
    const shareId = shareIds[int(0, shareIds.length - 1)];
    const bot = hex64(`fz${seed}p${i}`);
    const nVisits = int(0, 3);
    let lastEnd = now - int(0, 20) * DAY;
    let firstStart = lastEnd;
    for (let v = 0; v < nVisits; v++) {
      let cursor = now - int(0, 25) * DAY - int(0, 3_600_000);
      const start = cursor;
      const pageEvents: VisitInput["pageEvents"] = [];
      let sum = 0;
      for (let e = 0; e < int(0, 8); e++) {
        const dur = rnd() < 0.1 ? 0 : int(1, rnd() < 0.1 ? 900_000 : 30_000);
        const reason = REASONS[int(0, REASONS.length - 1)];
        pageEvents.push({
          pageNumber: rnd() < 0.05 ? P + int(1, 3) : int(1, P),
          enteredAt: new Date(cursor),
          leftAt: rnd() < 0.03 ? null : new Date(cursor + dur),
          durationMs: dur,
          ...(reason !== undefined ? { reason } : {}),
          ...(reason === "turn" && rnd() < 0.7 ? { toPage: int(0, P + 1) } : {}),
        });
        cursor += dur + (rnd() < 0.2 ? int(0, 600_000) : 0);
        sum += dur;
      }
      const seen = Array.from({ length: int(0, P) }, () => int(0, P + 1));
      visits.push({
        visitId: `fz${seed}p${i}v${v}`,
        shareId,
        botIdHash: rnd() < 0.05 ? hex64(`stray${seed}${i}${v}`) : bot,
        startedAt: new Date(start),
        lastEventAt: new Date(cursor),
        timeSpentMs: sum + int(0, 5000),
        pagesSeen: seen,
        pageEvents,
        timingVersion: rnd() < 0.5 ? 2 : null,
      });
      lastEnd = Math.max(lastEnd, cursor);
      firstStart = Math.min(firstStart, start);
    }
    rows.push({
      shareId,
      botIdHash: bot,
      viewerUserId: null,
      viewerName: rnd() < 0.3 ? `Person ${i}` : null,
      viewerEmail: null,
      viewerEmailSnapshot: null,
      createdDate: new Date(firstStart),
      lastViewedAt: rnd() < 0.1 ? null : new Date(lastEnd),
      updatedDate: new Date(lastEnd),
      downloads: int(0, 2),
    });
  }
  const lastOpenedRows = [...new Set(rows.map((r) => r.shareId))].map((shareId) => ({
    shareId,
    lastMs: Math.max(...rows.filter((r) => r.shareId === shareId).map((r) => new Date(r.lastViewedAt ?? r.updatedDate).getTime())),
  }));
  return { P, rows, visits, links, lastOpenedRows, now };
}

function checkResponse(r: ReadingResponse, P: number) {
  const N = r.peopleWithDetail!;
  expect(r.pages).toHaveLength(P);
  expect(r.pages!.reduce((s, p) => s + p.leftHere, 0)).toBe(N);
  for (const p of r.pages!) {
    expect(p.readCount + p.passed).toBeLessThanOrEqual(p.reached);
    expect(p.reached).toBeLessThanOrEqual(p.stillReading);
    expect(p.stillReading).toBeLessThanOrEqual(N);
    expect(p.typicalMs === null).toBe(p.readCount < 3);
    expect(p.jumped).toBe(p.stillReading - p.reached);
    expect(p.fewMs === null).toBe(p.readCount === 0 || p.readCount >= 3);
    if (p.fewMs) expect(p.fewMs).toHaveLength(p.readCount);
  }
  expect(r.series.reduce((s, x) => s + x.people, 0)).toBe(r.people);
  expect(r.attention.rows.filter((x) => x.kind !== "not_opened").length).toBeLessThanOrEqual(ATTENTION_LIST_MAX);
  const firstLink = r.attention.rows.findIndex((x) => x.kind === "not_opened");
  if (firstLink !== -1) expect(r.attention.rows.slice(firstLink).every((x) => x.kind === "not_opened")).toBe(true);
  if (r.callouts?.mostSkipped) expect(r.callouts.mostSkipped.tiedPages).toContain(r.callouts.mostSkipped.page);
  if (r.callouts?.mostLeft) expect(r.callouts.mostLeft.tiedPages).toContain(r.callouts.mostLeft.page);
  expect(N).toBeLessThanOrEqual(r.people);
  expect(r.matrix!.rows.length).toBe(Math.min(N, r.matrix!.limit));
  for (const row of r.matrix!.rows) expect(row.cells).toHaveLength(P);
  expect(r.totalMs).toBeGreaterThanOrEqual(r.matrix!.rows.reduce((s, m) => s + m.totalMs, 0));
  expect(r.calloutGate).toBe(calloutGateText(r.people, N));
  expect(r.callouts === null).toBe(N < 5);
  for (const text of [r.calloutGate, calloutGateText(r.people, N), calloutGateText(r.people, Math.min(4, N))]) {
    if (text) expect(text).not.toMatch(READ_WORD);
  }
  for (const row of r.attention.rows) {
    if (row.kind === "hot") expect(hotReasonText(row.reason)).not.toMatch(READ_WORD);
  }
}

describe("fuzz: 200 seeded sets", () => {
  test("identities hold at doc and link scope", () => {
    let withPeople = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const input = randomSet(seed);
      const core = buildReadingCore({ ...input, doc: { slideNodes: Array.from({ length: input.P }, (_, i) => ({ pageNumber: i + 1 })), pageSlugs: [] }, completedUploads: 1 });
      if (core.people.length > 0) withPeople += 1;

      const anonNames = new Set<string>();
      for (const p of core.people) {
        expect(p.cells).toHaveLength(input.P);
        expect(p.totalMs).toBe(p.visits.reduce((s, v) => s + v.timeSpentMs, 0));
        if (p.hasDetail) expect(p.exitPage).not.toBeNull();
        for (const v of p.visits) for (const page of v.untimedTail) if (p.cells[page - 1].ms === 0) expect(p.cells[page - 1].state).toBe("unknown");
        if (p.anonNumber !== null) {
          expect(anonNames.has(p.name)).toBe(false);
          anonNames.add(p.name);
        }
        if (p.hasDetail) {
          const pr = buildPersonResponse(core, p, { days: 30, now: input.now });
          expect(pr.pages.filter((pg) => pg.leftHere)).toHaveLength(1);
          // The sheet's typical time per page is the doc page table's, and a ratio needs five stayers.
          expect(pr.pages.map((pg) => [pg.typicalMs, pg.readCount])).toEqual(core.docPages.map((row) => [row.typicalMs, row.readCount]));
          for (const pg of pr.pages) if (pg.ratio !== null) expect(pg.state === "read" && pg.readCount >= 5 && pg.typicalMs !== null).toBe(true);
          for (const v of pr.visits) {
            const nv = p.visits.find((x) => x.visitId === v.visitId)!;
            expect(v.stops.reduce((s, x) => s + x.ms, 0)).toBe(nv.stops.reduce((s, x) => s + x.ms, 0));
            expect(v.stops.filter((x) => !x.passed && !x.untimed)).toHaveLength(nv.stops.length);
            expect(v.stops.filter((x) => x.untimed).map((x) => x.page)).toEqual(nv.untimedTail);
            for (const x of v.stops) if (x.passed || x.untimed) expect(x.ms).toBe(0);
            for (const page of v.passedPages) expect(nv.untimedTail).not.toContain(page);
          }
        }
      }
      const withDetail = core.people.filter((p) => p.hasDetail).length;
      // Past the cap only tie-band members (within 10% of the last kept score, so never returners) and
      // one reserved long-page person.
      const hotEntries = core.people.filter((p) => core.hotByKey.get(p.key)).map((p) => core.hotByKey.get(p.key)!);
      const cap = Math.max(HOT_MIN_KEEP, Math.ceil(HOT_MAX_SHARE * withDetail));
      const returners = hotEntries.filter((h) => h.kind === "returned").length;
      expect(returners).toBeLessThanOrEqual(cap);
      expect(hotEntries.length).toBeLessThanOrEqual(withDetail);
      for (const reason of core.hotByKey.values()) if (reason) expect(hotReasonText(reason)).not.toMatch(READ_WORD);

      const doc = buildReadingResponse(core, { tier: "deep", days: 30, daysLimit: null, shareId: null, matrixLimit: 500, now: input.now });
      checkResponse(doc, input.P);
      expect(doc.people).toBe(core.people.length);
      expect(doc.totalMs).toBe(core.people.reduce((s, p) => s + p.totalMs, 0));
      expect(doc.totalMs).toBeGreaterThanOrEqual(doc.matrix!.rows.reduce((s, m) => s + m.totalMs, 0));
      expect(doc.links.reduce((s, l) => s + l.people, 0)).toBe(doc.people);
      expect(doc.everOpened).toBe(doc.lastOpenedAtAllTime !== null);
      for (const l of doc.links) {
        expect(l.everOpened).toBe(l.lastOpenedAtAllTime !== null);
        if (l.people > 0) expect(l.lastOpenedAt).toBe(l.lastOpenedAtAllTime);
      }
      for (const row of doc.attention.rows) {
        if (row.kind === "not_opened") expect(doc.links.find((l) => l.shareId === row.shareId)?.everOpened).toBe(false);
      }

      const basic = buildReadingResponse(core, { tier: "basic", days: 7, daysLimit: 7, shareId: null, matrixLimit: 25, now: input.now });
      expect(Object.keys(basic).sort()).toEqual([...BASIC_READING_KEYS].sort());
      expect(basic.totalMs).toBe(doc.totalMs);

      for (const l of input.links) {
        const scoped = buildReadingResponse(core, { tier: "deep", days: 30, daysLimit: null, shareId: l.shareId, matrixLimit: 500, now: input.now });
        checkResponse(scoped, input.P);
        const scopedPeople = core.people.filter((p) => p.shareId === l.shareId);
        expect(scoped.people).toBe(scopedPeople.length);
        expect(scoped.totalMs).toBe(scopedPeople.reduce((s, p) => s + p.totalMs, 0));
      }
    }
    expect(withPeople).toBeGreaterThan(150);
  });
});
