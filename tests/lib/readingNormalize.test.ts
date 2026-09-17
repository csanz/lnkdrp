/**
 * Stop merging, dwell, seen pages and exit page for one visit (spec §3.2), and people built from
 * rows + visits (§3.3), using the hand-built fixtures.
 */
import { describe, expect, test } from "vitest";

import { STOP_CAP_MS, buildPeople, normalizeVisit, toMs } from "@/lib/analytics/reading";

import {
  F1,
  F10,
  F2,
  F3,
  F4,
  F5,
  F6,
  F7,
  F9,
  FLIPPER,
  ISAAC,
  LEGACY_TURN,
  LF1,
  LF2,
  MAYA,
  NADIA,
  SK1,
  T0,
  fixture,
  hex64,
  makeRow,
  makeVisit,
  personOf,
} from "./fixtures/readingFixtures";

describe("normalizeVisit", () => {
  test("F1 legacy events merge by adjacency only", () => {
    const v = normalizeVisit(F1.visits[0], 4);
    expect(v.stops).toHaveLength(7);
    expect(v.stopsByPage).toEqual([1, 2, 3, 1]);
    expect(v.dwellByPage).toEqual([4987, 7215, 12464, 4063]);
    expect(v.exitPage).toBe(3);
    expect(v.exitInferred).toBe(false);
    expect(v.tv2).toBe(false);
    expect(v.stops.map((s) => s.revisit)).toEqual([false, false, false, false, true, true, true]);
  });

  test("F2 hidden split continues the stop; turn starts a new one", () => {
    const v = normalizeVisit(F2.visits[0], 5);
    expect(v.stops.map((s) => s.ms)).toEqual([3000, 10000, 25000]);
    expect(v.stops.some((s) => s.revisit)).toBe(false);
    expect(v.stops[1].reason).toBe("turn");
    expect(v.exitPage).toBe(3);
    expect(v.tv2).toBe(true);
  });

  test("F3 same page after a turn is a revisit", () => {
    const v = normalizeVisit(F3.visits[0], 4);
    expect(v.stopsByPage).toEqual([1, 2, 0, 0]);
    expect(v.dwellByPage).toEqual([5000, 15000, 0, 0]);
    expect(v.stops[2].revisit).toBe(true);
    expect(v.seen).toEqual([1, 2, 3]);
    expect(v.exitPage).toBe(2);
  });

  test("F4 adjacent legacy events on one page make one stop", () => {
    const v = normalizeVisit(F4.visits[0], 3);
    expect(v.stops).toEqual([{ page: 2, ms: 7000, revisit: false, reason: null, toPage: null }]);
  });

  test("a visit ending on a turn exits on the turn's target (lost final flush)", () => {
    const nadia = normalizeVisit(NADIA.visits[0], 12);
    expect(nadia.exitPage).toBe(12);
    expect(nadia.exitInferred).toBe(true);
    expect(nadia.timed).toBe(true);
    expect(nadia.stops[10]).toMatchObject({ page: 11, reason: "turn", toPage: 12 });
    expect(nadia.untimedTail).toEqual([12]);

    const maya = normalizeVisit(MAYA.visits[0], 12);
    expect(maya.exitPage).toBe(2);
    expect(maya.exitInferred).toBe(true);
    expect(maya.untimedTail).toEqual([2]);
  });

  test("LF1: later untimed pages after a lost turn form the tail; activity after the flush exits on the last of them", () => {
    const v = normalizeVisit(LF1.visits[0], 12);
    expect(v.untimedTail).toEqual([6, 7, 8]);
    expect(v.exitPage).toBe(8);
    expect(v.exitInferred).toBe(true);
    expect(v.lastEventAtMs - v.startedAtMs).toBe(6730 + 3479 + 2150);
  });

  test("LF2: no activity after the lost turn's flush exits on the turn's target", () => {
    const v = normalizeVisit(LF2.visits[0], 12);
    expect(v.untimedTail).toEqual([6, 7, 8]);
    expect(v.exitPage).toBe(6);
    expect(v.exitInferred).toBe(true);
  });

  test("the tail always holds the target, even one timed earlier, but no later page that was timed or turned to earlier", () => {
    const v = normalizeVisit(
      makeVisit({ shareId: "shareT9", botIdHash: hex64("t9"), events: [[3, 4000, "turn", 4], [4, 5000, "turn", 5], [7, 3000, "turn", 3]], seen: [1, 3, 4, 5, 6, 7] }),
      8,
    );
    expect(v.untimedTail).toEqual([3, 6]);
    expect(v.exitPage).toBe(3);
  });

  test("a turn without toPage, or with a target outside seen or 1..P, keeps the latest event's page", () => {
    const legacy = normalizeVisit(LEGACY_TURN.visits[0], 12);
    expect(legacy.exitPage).toBe(1);
    expect(legacy.exitInferred).toBe(false);
    expect(legacy.stops[0].toPage).toBeNull();
    expect(legacy.untimedTail).toEqual([]);

    const outside = makeVisit({ shareId: "shareT1", botIdHash: hex64("t1"), events: [[1, 5000, "turn", 3]], seen: [1] });
    expect(normalizeVisit(outside, 12)).toMatchObject({ exitPage: 1, exitInferred: false });
    const pastP = makeVisit({ shareId: "shareT1", botIdHash: hex64("t2"), events: [[1, 5000, "turn", 13]], seen: [1] });
    expect(normalizeVisit(pastP, 12).stops[0].toPage).toBeNull();
    const notTurn = makeVisit({ shareId: "shareT1", botIdHash: hex64("t3"), events: [[1, 5000, "pagehide", 2]], seen: [1, 2] });
    expect(normalizeVisit(notTurn, 12)).toMatchObject({ exitPage: 1, exitInferred: false });
  });

  test("a turn only sets toPage on the stop it ends", () => {
    const v = normalizeVisit(FLIPPER.visits[0], 12);
    expect(v.stops.map((s) => [s.page, s.toPage, s.revisit])).toEqual([
      [1, 11, false],
      [11, 12, false],
      [11, 10, true],
      [10, null, false],
    ]);
    expect(v.exitPage).toBe(10);
    expect(v.exitInferred).toBe(false);
  });

  test("F9 stop dwell is capped", () => {
    const v = normalizeVisit(F9.visits[0], 2);
    expect(v.stops[0].ms).toBe(STOP_CAP_MS);
    expect(v.dwellByPage[0]).toBe(600_000);
  });

  test("F10 events past P are dropped; exit inferred from seen", () => {
    const v = normalizeVisit(F10.visits[0], 4);
    expect(v.droppedEvents).toBe(1);
    expect(v.seen).toEqual([1]);
    expect(v.timed).toBe(false);
    expect(v.exitPage).toBe(1);
    expect(v.exitInferred).toBe(true);
  });

  test("F7 untimed visit infers the exit from the highest seen page", () => {
    const v = normalizeVisit(F7.visits[0], 4);
    expect(v.timed).toBe(false);
    expect(v.exitPage).toBe(2);
    expect(v.exitInferred).toBe(true);
  });

  test("invalid events are dropped and counted", () => {
    const v = normalizeVisit(
      {
        visitId: "x",
        shareId: "shareX1",
        botIdHash: hex64("x"),
        startedAt: new Date(T0),
        lastEventAt: new Date(T0),
        timeSpentMs: 0,
        pagesSeen: [0, 1.5, "2", 3],
        pageEvents: [
          { pageNumber: 1, enteredAt: new Date(T0), leftAt: new Date(T0 + 1), durationMs: 0 },
          { pageNumber: 1, enteredAt: "not a date", leftAt: new Date(T0 + 1), durationMs: 10 },
          { pageNumber: "1", enteredAt: new Date(T0), leftAt: new Date(T0 + 1), durationMs: 10 },
          { pageNumber: 2, enteredAt: new Date(T0).toISOString(), leftAt: new Date(T0 + 50).toISOString(), durationMs: 50 },
        ],
      },
      4,
    );
    expect(v.droppedEvents).toBe(3);
    expect(v.seen).toEqual([2, 3]);
    expect(v.exitPage).toBe(2);
  });

  test("exit ties on leftAt go to the later event in sort order", () => {
    const v = normalizeVisit(
      {
        visitId: "y",
        shareId: "shareY1",
        botIdHash: hex64("y"),
        startedAt: new Date(T0),
        lastEventAt: new Date(T0 + 100),
        timeSpentMs: 100,
        pagesSeen: [],
        pageEvents: [
          { pageNumber: 2, enteredAt: new Date(T0 + 50), leftAt: new Date(T0 + 100), durationMs: 50 },
          { pageNumber: 1, enteredAt: new Date(T0), leftAt: new Date(T0 + 100), durationMs: 100 },
        ],
      },
      2,
    );
    expect(v.exitPage).toBe(2);
  });

  test("toMs", () => {
    expect(toMs(null)).toBeNull();
    expect(toMs("nope")).toBeNull();
    expect(toMs(new Date(T0))).toBe(T0);
    expect(toMs(new Date(T0).toISOString())).toBe(T0);
  });
});

describe("buildPeople", () => {
  test("F1 cells, stayed pages and time", () => {
    const p = personOf(F1);
    expect(p.cells.map((c) => c.state)).toEqual(["read", "read", "read", "read"]);
    expect(p.readPages).toBe(4);
    expect(p.exitPage).toBe(3);
    expect(p.revisitsByPage).toEqual([0, 1, 2, 0]);
    expect(p.totalMs).toBe(4987 + 5016 + 1519 + 4063 + 5493 + 2199 + 5452);
  });

  test("F3 cells", () => {
    const p = personOf(F3);
    expect(p.cells).toEqual([
      { ms: 5000, state: "read", revisit: false },
      { ms: 15000, state: "read", revisit: true },
      { ms: 0, state: "passed", revisit: false },
      { ms: 0, state: "unreached", revisit: false },
    ]);
    expect(p.exitPage).toBe(2);
  });

  test("F5 bounce is passed", () => {
    const p = personOf(F5);
    expect(p.cells[0].state).toBe("passed");
    expect(p.cells.slice(1).every((c) => c.state === "unreached")).toBe(true);
  });

  test("an exit reached by a lost turn is unknown, not passed", () => {
    const nadia = personOf(NADIA);
    expect(nadia.exitPage).toBe(12);
    expect(nadia.cells[11]).toEqual({ ms: 0, state: "unknown", revisit: false });
    expect(nadia.cells.slice(0, 11).every((c) => c.state === "read")).toBe(true);
    expect(nadia.readPages).toBe(11);

    const maya = personOf(MAYA);
    expect(maya.exitPage).toBe(2);
    expect(maya.cells.map((c) => c.state)).toEqual(["read", "unknown", ...new Array(10).fill("unreached")]);

    const legacy = personOf(LEGACY_TURN);
    expect(legacy.exitPage).toBe(1);
    expect(legacy.cells[1].state).toBe("passed");
  });

  test("LF1 and LF2: every untimed tail page is unknown, never passed", () => {
    for (const fx of [LF1, LF2]) {
      const p = personOf(fx);
      expect(p.cells.map((c) => c.state)).toEqual(["passed", "read", "passed", "passed", "read", "unknown", "unknown", "unknown", ...new Array(4).fill("unreached")]);
      expect(p.readPages).toBe(2);
    }
    expect(personOf(LF1).exitPage).toBe(8);
    expect(personOf(LF2).exitPage).toBe(6);
  });

  test("a tail page timed in another visit keeps its timed state", () => {
    const fx = fixture(12, [
      {
        name: "LFother",
        visits: [
          { visitId: "lfo-1", start: T0, events: [[7, 5000, "pagehide"]], seen: [7] },
          { visitId: "lfo-2", start: T0 + 3_600_000, events: [[2, 6730, "turn", 3], [5, 3479, "turn", 6]], seen: [1, 2, 3, 4, 5, 6, 7, 8], tailMs: 2150 },
        ],
      },
    ]);
    const p = personOf(fx);
    expect(p.cells.slice(5, 8).map((c) => c.state)).toEqual(["unknown", "read", "unknown"]);
  });

  test("a flip on a timed person's page that is not the untimed exit stays passed", () => {
    const p = personOf(FLIPPER);
    expect(p.exitPage).toBe(10);
    expect(p.cells[11].state).toBe("passed");
  });

  test("pages before the furthest page that were never on screen are jumped", () => {
    const p = personOf(ISAAC);
    expect(p.cells.map((c) => c.state)).toEqual(["read", ...new Array(8).fill("jumped"), "read", "unreached", "unreached", "unreached"]);
    expect(p.maxPage).toBe(10);
    expect(p.reachedCount).toBe(2);
  });

  test("F6 returner: union of seen pages, exit from the latest visit, totalMs over visits", () => {
    const p = personOf(F6);
    expect(p.seen).toEqual([1, 2, 5, 6]);
    expect(p.cells.map((c) => c.state)).toEqual(["read", "read", "jumped", "jumped", "read", "read"]);
    expect(p.maxPage).toBe(6);
    expect(p.exitPage).toBe(6);
    expect(p.latestVisit?.visitId).toBe("f6-v2");
    expect(p.totalMs).toBe(140000);
  });

  test("F7 untimed person", () => {
    const p = personOf(F7);
    expect(p.cells.map((c) => c.state)).toEqual(["unknown", "unknown", "unreached", "unreached"]);
    expect(p.exitPage).toBe(2);
    expect(p.latestVisit?.exitInferred).toBe(true);
    expect(p.totalMs).toBe(9000);
    expect(p.hasDetail).toBe(true);
  });

  test("SK1 skimmer", () => {
    const p = personOf(SK1);
    expect(p.readPages).toBe(1);
    expect(p.exitPage).toBe(10);
    expect(p.cells.slice(0, 9).every((c) => c.state === "passed")).toBe(true);
  });

  test("unmatched visits are counted and excluded; rows without visits are people without detail", () => {
    const share = "shareM1";
    const bot = hex64("m1");
    const other = hex64("m2");
    const visit = makeVisit({ shareId: share, botIdHash: other, events: [[1, 5000, "pagehide"]] });
    const row = makeRow({ shareId: share, botIdHash: bot, createdDate: new Date(T0), updatedDate: new Date(T0) });
    const out = buildPeople([row], [visit], [], 3, T0);
    expect(out.unmatchedVisits).toBe(1);
    expect(out.people).toHaveLength(1);
    expect(out.people[0].hasDetail).toBe(false);
    expect(out.people[0].totalMs).toBe(0);
    expect(out.people[0].linkLabel).toBe("Deleted link");
    expect(out.people[0].cells).toHaveLength(3);
  });

  test("signed-in rows merge by user id on one link; identity from the latest row", () => {
    const share = "shareU1";
    const uid = "0123456789abcdef01234567";
    const r1 = makeRow({
      shareId: share,
      botIdHash: hex64("u1"),
      viewerUserId: uid,
      viewerName: "Old Name",
      viewerEmail: "old@example.test",
      createdDate: new Date(T0 - 1000),
      updatedDate: new Date(T0),
      downloads: 1,
    });
    const r2 = makeRow({
      shareId: share,
      botIdHash: hex64("u2"),
      viewerUserId: uid,
      viewerName: "Dana Lee",
      viewerEmail: "dana@example.test",
      viewerEmailSnapshot: "dana.snap@example.test",
      createdDate: new Date(T0),
      updatedDate: new Date(T0 + 5000),
      downloads: 2,
    });
    const v1 = makeVisit({ shareId: share, botIdHash: hex64("u1"), events: [[1, 3000, "pagehide"]] });
    const v2 = makeVisit({ shareId: share, botIdHash: hex64("u2"), start: T0 + 4000, events: [[2, 1000, "pagehide"]] });
    const { people } = buildPeople([r1, r2], [v1, v2], [], 2, T0);
    expect(people).toHaveLength(1);
    const p = people[0];
    expect(p.key).toBe(`${share}|u:${uid}`);
    expect(p.source).toBe("signed_in");
    expect(p.name).toBe("Dana Lee");
    expect(p.email).toBe("dana.snap@example.test");
    expect(p.firstSeenMs).toBe(T0 - 1000);
    expect(p.lastSeenMs).toBe(T0 + 5000);
    expect(p.downloads).toBe(3);
    expect(p.visits).toHaveLength(2);
    expect(p.personId).toBe(`${share}.u.${uid}`);
  });

  test("introduced identity prefers viewerEmail", () => {
    const row = makeRow({
      shareId: "shareI1",
      botIdHash: hex64("i1"),
      viewerEmail: "pat@firm.test",
      viewerEmailSnapshot: "other@firm.test",
      createdDate: new Date(T0),
      updatedDate: new Date(T0),
    });
    const { people } = buildPeople([row], [], [], 2, T0);
    expect(people[0].source).toBe("introduced");
    expect(people[0].name).toBe("pat@firm.test");
    expect(people[0].email).toBe("pat@firm.test");
  });
});
