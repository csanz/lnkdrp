/**
 * Response builders (spec §3.9): RESP1 doc and link scope, the basic whitelist, person responses,
 * and a seeded fuzz over the page-table identities.
 */
import { describe, expect, test } from "vitest";

import {
  BASIC_LINK_KEYS,
  BASIC_READING_KEYS,
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
  L0,
  L1,
  ORPHAN,
  PT1,
  PT1_NOW,
  RESP1,
  RESP1_CORE,
  RESP1_LAST_OPENED,
  T0,
  coreOf,
  hex64,
  makeLink,
  personResponseF1,
  personResponseF6,
  personResponsePT1A,
  readingResponseBasicAT1,
  readingResponseDeepPT1,
} from "./fixtures/readingFixtures";

const iso = (ms: number) => new Date(ms).toISOString();
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
    expect(r.attention.rows.map((x) => x.kind)).toEqual(["active", "hot", "hot", "not_opened"]);
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

  test("readingResponseBasicAT1", () => {
    expect(Object.keys(readingResponseBasicAT1).sort()).toEqual([...BASIC_READING_KEYS].sort());
    expect(readingResponseBasicAT1.attention.rows).toHaveLength(1);
  });

  test("personResponseF1", () => {
    const r = personResponseF1;
    expect(r.verdict.text).toBe("Went through all 4 pages. Went back to page 3.");
    expect(r.person.hot && hotReasonText(r.person.hot)).toBe("Stayed on 4 of 4 pages");
    expect(r.person.activeNow).toBe(false);
    expect(r.pages).toHaveLength(4);
    expect(r.pages.every((p) => p.typicalMs === null)).toBe(true);
    expect(r.pages.map((p) => p.leftHere)).toEqual([false, false, true, false]);
    expect(r.pages.map((p) => p.revisits)).toEqual([0, 1, 2, 0]);
    expect(r.visits).toHaveLength(1);
    expect(r.visits[0].exitPage).toBe(3);
    expect(r.visits[0].passedPages).toEqual([]);
    expect(r.facts).toEqual({ visits: 1, totalMs: 28729, reachedCount: 4, maxPage: 4, exitPage: 3 });
    expect(r.more.visits).toBe(0);
  });

  test("personResponseF6", () => {
    const r = personResponseF6;
    expect(r.person.hot).toEqual({ kind: "returned", gapMs: 70 * 3_600_000 - 50_000 });
    expect(r.visits.map((v) => v.visitId)).toEqual(["f6-v2", "f6-v1"]);
    expect(r.visits[0].passedPages).toEqual([1]);
    expect(r.facts.totalMs).toBe(140000);
  });

  test("personResponsePT1A", () => {
    const r = personResponsePT1A;
    expect(r.pages.map((p) => p.typicalMs)).toEqual([4000, 30000, null, null]);
    expect(r.person.activeNow).toBe(true);
    expect(r.facts.exitPage).toBe(4);
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
  }
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

      for (const p of core.people) {
        expect(p.cells).toHaveLength(input.P);
        expect(p.totalMs).toBe(p.visits.reduce((s, v) => s + v.timeSpentMs, 0));
        if (p.hasDetail) expect(p.exitPage).not.toBeNull();
      }
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
