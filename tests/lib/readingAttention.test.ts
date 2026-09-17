/**
 * Hot reasons, link status and the needs-attention rows (spec §3.5).
 */
import { describe, expect, test } from "vitest";

import {
  buildAttention,
  buildReadingResponse,
  computeHot,
  hotReasonText,
  largestReturnGap,
  linkStatus,
} from "@/lib/analytics/reading";

import {
  AT1,
  AT2,
  DAY,
  F1,
  F6,
  HOUR,
  L0,
  PT1,
  PT1_NOW,
  SK1,
  SR1,
  SR2,
  SR3,
  T0,
  coreOf,
  fixture,
  type EventSpec,
  makeLink,
  peopleOf,
  personOf,
} from "./fixtures/readingFixtures";

describe("computeHot", () => {
  test("F1 alone on a 4-page doc: stayed on all pages", () => {
    const hot = computeHot(peopleOf(F1), 4);
    const r = hot.get(F1.keys[0]);
    expect(r).toEqual({ kind: "read_most", read: 4, pageCount: 4, totalMs: 28729 });
    expect(hotReasonText(r!)).toBe("Stayed on 4 of 4 pages · 28s");
  });

  test("F6 returner", () => {
    const p = personOf(F6);
    expect(largestReturnGap(p)).toBe(70 * HOUR - 50_000);
    expect(computeHot([p], 6).get(p.key)).toEqual({
      kind: "returned",
      gapMs: 70 * HOUR - 50_000,
      fromAt: new Date(T0 + 50_000).toISOString(),
      toAt: new Date(T0 + 70 * HOUR).toISOString(),
    });
  });

  test("PT1", () => {
    const hot = computeHot(peopleOf(PT1), 4);
    const [A, B, C, D, E] = PT1.keys;
    expect(hot.get(A)).toEqual({ kind: "read_most", read: 4, pageCount: 4, totalMs: 49000 });
    // Page 3 has no typical time (two people stayed), so B falls back to the doc's typical page time
    // without B: 7000 (median of the other stayed pages).
    expect(hot.get(B)).toEqual({ kind: "dwell", page: 3, ms: 20000, ratio: 2.8, pageTypicalMs: null, pageRatio: null, docTypicalMs: 7000 });
    expect(hot.get(C)).toBeNull();
    // Page 2's typical time is 30s (A, D and E), the figure the page table shows; D's 40s is under twice that.
    expect(hot.get(D)).toBeNull();
    expect(hot.get(E)).toBeNull();
  });

  test("SR1 alone, with two peers, with three peers: a page ratio only from five people who stayed", () => {
    expect(computeHot(peopleOf(SR1), 4).get(SR1.keys[0])).toBeNull();
    // Three people stayed on page 2 (SR1 included): it has a typical time of 4s, so SR1 qualifies, but
    // the chip keeps the doc-typical wording.
    const two = computeHot(peopleOf(SR2), 4).get(SR2.keys[0]);
    expect(two).toEqual({ kind: "dwell", page: 2, ms: 40000, ratio: 10, pageTypicalMs: null, pageRatio: null, docTypicalMs: 4000 });
    const r = computeHot(peopleOf(SR3), 4).get(SR3.keys[0]);
    expect(r).toEqual({ kind: "dwell", page: 2, ms: 40000, ratio: 10, pageTypicalMs: null, pageRatio: null, docTypicalMs: 4000 });
    expect(hotReasonText(r!)).toBe("Spent 40s on page 2; most pages take about 4s");
  });

  test("a page with a typical time is judged by it, not the doc's", () => {
    // Page 2 takes people 30s; page 1 takes them 4s. 50s on page 2 is 12.5× the doc's typical page
    // but under 2× its own, so it is not hot.
    const peerDef = (i: number) => ({ name: `ownPeer${i}`, visits: [{ events: [[1, 4000, "turn", 2], [2, 30000, "turn", 3], [3, 4000, "pagehide"]] as EventSpec[] }] });
    const fx = fixture(4, [{ name: "ownX", visits: [{ events: [[1, 4000, "turn", 2], [2, 50000, "turn", 3], [3, 4000, "pagehide"]] }] }, peerDef(1), peerDef(2), peerDef(3)]);
    expect(computeHot(peopleOf(fx), 4).get(fx.keys[0])).toBeNull();

    // Three of four pages, so staying on most pages does not apply. Five people stayed on page 2, so
    // its own typical time and ratio are stated.
    const long = fixture(4, [{ name: "ownY", visits: [{ events: [[1, 4000, "turn", 2], [2, 70000, "turn", 3], [3, 4000, "pagehide"]] }] }, peerDef(1), peerDef(2), peerDef(3), peerDef(4)]);
    const r = computeHot(peopleOf(long), 4).get(long.keys[0]);
    expect(r).toMatchObject({ kind: "dwell", page: 2, ms: 70000, pageTypicalMs: 30000, pageRatio: 2.3 });
    expect(hotReasonText(r!)).toBe("Spent 1m 10s on page 2, 2.3× its typical 30s");
  });

  test("someone who stayed on every page outranks one-long-page people under the cap; dwell by page ratio", () => {
    const P = 6;
    const full = { name: "fullReader", visits: [{ events: Array.from({ length: P }, (_, i): EventSpec => (i + 1 < P ? [i + 1, 5000, "turn", i + 2] : [i + 1, 5000, "pagehide"])) }] };
    const longPage = (name: string, ms: number) => ({ name, visits: [{ events: [[1, 3000, "turn", 2], [2, ms, "pagehide"]] as EventSpec[] }] });
    const ordinary = (i: number) => ({ name: `ordinary${i}`, visits: [{ events: [[1, 3000, "turn", 2], [2, 3000, "turn", 3], [3, 3000, "pagehide"]] as EventSpec[] }] });
    const fx = fixture(P, [full, longPage("long60", 60000), longPage("long50", 50000), longPage("long40", 40000), ...[1, 2, 3, 4, 5, 6].map(ordinary)]);
    const hot = computeHot(peopleOf(fx), P);
    expect(fx.keys.map((k) => hot.get(k)?.kind ?? null)).toEqual(["read_most", "dwell", "dwell", null, null, null, null, null, null, null]);
    expect(hot.get(fx.keys[1])).toMatchObject({ pageTypicalMs: 3000, pageRatio: 20 });
  });

  test("read most needs the last page and, with 3+ people, twice the others' median total", () => {
    const pages = (P: number, ms: number) => Array.from({ length: P }, (_, i) => [i + 1, ms, i + 1 < P ? "turn" : "pagehide"] as [number, number, string]);
    const skimmerPeers = [
      { name: "peerY", visits: [{ events: [[1, 5000, "turn"], [2, 5000, "pagehide"]] as Array<[number, number, string]> }] },
      { name: "peerZ", visits: [{ events: [[1, 5000, "turn"], [2, 5000, "pagehide"]] as Array<[number, number, string]> }] },
    ];
    const quick = fixture(4, [{ name: "quickX", visits: [{ events: pages(4, 3000) }] }, ...skimmerPeers]);
    expect(computeHot(peopleOf(quick), 4).get(quick.keys[0])).toBeNull();
    const slow = fixture(4, [{ name: "slowX", visits: [{ events: pages(4, 6000) }] }, ...skimmerPeers]);
    expect(computeHot(peopleOf(slow), 4).get(slow.keys[0])).toEqual({ kind: "read_most", read: 4, pageCount: 4, totalMs: 24000 });

    const shortOfEnd = fixture(5, [{ name: "shortOfEnd", visits: [{ events: pages(4, 6000) }] }]);
    expect(computeHot(peopleOf(shortOfEnd), 5).get(shortOfEnd.keys[0])).toBeNull();
  });

  test("only the strongest max(3, 20% of people with detail) stay hot: returners latest first", () => {
    const returner = (i: number) => ({
      name: `R${i}`,
      visits: [
        { visitId: `r${i}-a`, start: T0, events: [[1, 3000, "pagehide"]] as Array<[number, number, string]> },
        { visitId: `r${i}-b`, start: T0 + 13 * HOUR + i * HOUR, events: [[1, 3000, "pagehide"]] as Array<[number, number, string]> },
      ],
    });
    const fx = fixture(3, [1, 2, 3, 4, 5].map(returner).concat([{ name: "plain", visits: [{ visitId: "plain-a", start: T0, events: [[1, 3000, "pagehide"]] }] }]), {
      now: T0 + 2 * DAY,
    });
    const hot = computeHot(peopleOf(fx), 3);
    expect(fx.keys.map((k) => hot.get(k)?.kind ?? null)).toEqual([null, null, "returned", "returned", "returned", null]);
  });

  test("the cap never cuts inside a tie band, and named people lead their band", () => {
    const P = 4;
    const full = (name: string, total: number, row?: { viewerName: string }) => {
      const each = Math.floor(total / P);
      const events = Array.from({ length: P }, (_, i): EventSpec => {
        const ms = i + 1 < P ? each : total - each * (P - 1);
        return i + 1 < P ? [i + 1, ms, "turn", i + 2] : [i + 1, ms, "pagehide"];
      });
      return { name, visits: [{ events }], ...(row ? { row } : {}) };
    };
    const skimmer = (i: number) => ({ name: `skim${i}`, visits: [{ events: [[1, 3000, "pagehide"]] as EventSpec[] }] });
    // 25 people with detail keep max(3, 5) = 5. The fifth, r11, has 273,117ms; Nadia's 269,885ms and
    // r23's 267,000ms are within 10% of it, 200,000ms is not.
    const fx = fixture(P, [
      full("r15", 411000),
      full("r22", 320000),
      full("r10", 300000),
      full("r8", 280000),
      full("r11", 273117),
      full("nadia", 269885, { viewerName: "Nadia Mbeki" }),
      full("r23", 267000),
      full("r5", 200000),
      ...Array.from({ length: 17 }, (_, i) => skimmer(i)),
    ]);
    const people = peopleOf(fx);
    const hot = computeHot(people, P);
    expect(fx.keys.slice(0, 8).map((k) => hot.get(k)?.kind ?? null)).toEqual([...new Array(7).fill("read_most"), null]);
    expect(hot.get(fx.keys[5])).toEqual({ kind: "read_most", read: 4, pageCount: 4, totalMs: 269885 });
    expect(hotReasonText(hot.get(fx.keys[5])!)).toBe("Stayed on 4 of 4 pages · 4m 29s");

    const rows = buildAttention({ people, links: fx.links, openedShareIds: new Set([fx.links[0].shareId]), hotByKey: hot, now: fx.now, tier: "deep" });
    const nameByPersonId = new Map(people.map((p, i) => [p.personId, ["r15", "r22", "r10", "r8", "r11", "nadia", "r23"][i] ?? "other"]));
    // Bands: [411s], [320s, 300s], [280s, 273s, 270s, 267s] with the named person first.
    expect(rows.rows.map((r) => (r.kind === "hot" ? nameByPersonId.get(r.personId) : r.kind))).toEqual(["r15", "r22", "r10", "nadia", "r8", "r11", "r23"]);
    const nadia = rows.rows.find((r) => r.kind === "hot" && nameByPersonId.get(r.personId) === "nadia");
    expect(nadia).toMatchObject({ totalMs: 269885, exitPage: 4 });
  });

  test("when no long-page person survives the cap, the strongest one keeps a slot", () => {
    const P = 4;
    const full = (name: string, each: number) => ({
      name,
      visits: [{ events: Array.from({ length: P }, (_, i): EventSpec => (i + 1 < P ? [i + 1, each, "turn", i + 2] : [i + 1, each, "pagehide"])) }],
    });
    const ordinary = (i: number) => ({ name: `ord${i}`, visits: [{ events: [[1, 3000, "turn", 2], [2, 3000, "pagehide"]] as EventSpec[] }] });
    const fx = fixture(P, [
      full("full140", 35000),
      full("full120", 30000),
      full("full100", 25000),
      { name: "longPage", visits: [{ events: [[1, 3000, "turn", 2], [2, 70000, "pagehide"]] }] },
      { name: "longPage2", visits: [{ events: [[1, 3000, "turn", 2], [2, 50000, "pagehide"]] }] },
      ...Array.from({ length: 5 }, (_, i) => ordinary(i)),
    ]);
    const hot = computeHot(peopleOf(fx), P);
    expect(fx.keys.map((k) => hot.get(k)?.kind ?? null)).toEqual(["read_most", "read_most", "read_most", "dwell", null, null, null, null, null, null]);
    // Page 2 stayed: 3s ×5, 25s, 30s, 35s, 50s, 70s → typical 14s. Both long-page people qualify; only the stronger is kept.
    expect(hot.get(fx.keys[3])).toMatchObject({ page: 2, ms: 70000, pageTypicalMs: 14000, pageRatio: 5 });
  });

  test("page 1 time summed over several visits is never a long-page reason", () => {
    const ordinary = (i: number) => ({ name: `cov${i}`, visits: [{ events: [[1, 3000, "turn", 2], [2, 3000, "pagehide"]] as EventSpec[] }] });
    const fx = fixture(
      4,
      [
        {
          name: "coverTwice",
          visits: [
            { visitId: "ct-a", start: T0, events: [[1, 9000, "pagehide"]] },
            { visitId: "ct-b", start: T0 + 2 * HOUR, events: [[1, 8000, "turn", 2], [2, 3000, "pagehide"]] },
          ],
        },
        ...Array.from({ length: 5 }, (_, i) => ordinary(i)),
      ],
      { now: T0 + 3 * HOUR },
    );
    expect(computeHot(peopleOf(fx), 4).get(fx.keys[0])).toBeNull();
  });

  test("SK1 skimmer is not hot", () => {
    expect(computeHot(peopleOf(SK1), 10).get(SK1.keys[0])).toBeNull();
  });

  test("people without detail are never hot", () => {
    const p = { ...personOf(F1), hasDetail: false };
    expect(computeHot([p], 4).get(p.key)).toBeNull();
  });
});

describe("hotReasonText", () => {
  const returned = (from: string, hours: number) => {
    const fromMs = Date.parse(from);
    return { kind: "returned" as const, gapMs: hours * HOUR, fromAt: new Date(fromMs).toISOString(), toAt: new Date(fromMs + hours * HOUR).toISOString() };
  };

  test("exact strings", () => {
    const LA = "America/Los_Angeles";
    // 03:09 on Aug 28 to 22:45 on Aug 30, Los Angeles time.
    expect(hotReasonText(returned("2026-08-28T10:09:00.000Z", 67.6), LA)).toBe("Came back 2 days later");
    // 08:00 on Sep 10 to 23:00 on Sep 11.
    expect(hotReasonText(returned("2026-09-10T15:00:00.000Z", 39), LA)).toBe("Came back the next day");
    expect(hotReasonText(returned("2026-09-10T15:00:00.000Z", 14), LA)).toBe("Came back 14 hours later");
    expect(hotReasonText({ kind: "dwell", page: 2, ms: 40000, ratio: 5.7, pageTypicalMs: null, pageRatio: null, docTypicalMs: 7000 })).toBe(
      "Spent 40s on page 2; most pages take about 7s",
    );
    expect(hotReasonText({ kind: "dwell", page: 2, ms: 70000, ratio: 5.8, pageTypicalMs: 8000, pageRatio: 8.7, docTypicalMs: 12000 })).toBe(
      "Spent 1m 10s on page 2, 8.7× its typical 8s",
    );
    expect(hotReasonText({ kind: "read_most", read: 3, pageCount: 4, totalMs: 273117 })).toBe("Stayed on 3 of 4 pages · 4m 33s");
  });
});

describe("linkStatus", () => {
  test("archived > disabled > expired > active", () => {
    const now = T0;
    expect(linkStatus(makeLink({ shareId: "s1xx", archivedAt: new Date(now), enabled: false }), now)).toBe("archived");
    expect(linkStatus(makeLink({ shareId: "s2xx", enabled: false, expiresAt: new Date(now - 1) }), now)).toBe("disabled");
    expect(linkStatus(makeLink({ shareId: "s3xx", expiresAt: new Date(now) }), now)).toBe("expired");
    expect(linkStatus(makeLink({ shareId: "s4xx", expiresAt: new Date(now + 1) }), now)).toBe("active");
  });
});

describe("buildAttention", () => {
  const people = peopleOf(AT1);
  const hotByKey = computeHot(people, 4);
  const [A, B] = people;

  test("AT1 deep", () => {
    const out = buildAttention({ people, links: AT1.links, openedShareIds: new Set([L0]), hotByKey, now: PT1_NOW, tier: "deep" });
    expect(out.more).toBe(0);
    expect(out.rows).toEqual([
      { kind: "active", personId: A.personId, name: A.name, linkLabel: "Default link", page: 4, at: new Date(T0 + 3_300_000).toISOString(), totalMs: 49000, exitPage: 4 },
      {
        kind: "hot",
        personId: B.personId,
        name: B.name,
        linkLabel: "Default link",
        reason: { kind: "dwell", page: 3, ms: 20000, ratio: 2.8, pageTypicalMs: null, pageRatio: null, docTypicalMs: 7000 },
        lastSeen: new Date(T0 + 600_000).toISOString(),
        totalMs: 24000,
        exitPage: 3,
      },
      { kind: "not_opened", shareId: AT1.links[1].shareId, linkLabel: "Sequoia", sentAt: new Date(PT1_NOW - 72 * HOUR).toISOString() },
    ]);
  });

  test("AT1 basic", () => {
    const out = buildAttention({ people, links: AT1.links, openedShareIds: new Set([L0]), hotByKey, now: PT1_NOW, tier: "basic" });
    expect(out).toEqual({
      rows: [{ kind: "not_opened", shareId: AT1.links[1].shareId, linkLabel: "Sequoia", sentAt: new Date(PT1_NOW - 72 * HOUR).toISOString() }],
      more: 0,
    });
  });

  test("AT2 deep and basic", () => {
    const deep = buildAttention({ people, links: AT2.links, openedShareIds: new Set([L0]), hotByKey, now: PT1_NOW, tier: "deep" });
    expect(deep.rows.map((r) => (r.kind === "not_opened" ? r.linkLabel : `${r.kind}:${r.personId}`))).toEqual([
      `active:${A.personId}`,
      `hot:${B.personId}`,
      "N6",
      "N5",
      "N4",
      "N3",
      "N2",
      "N1",
    ]);
    expect(deep.more).toBe(0);

    const basic = buildAttention({ people, links: AT2.links, openedShareIds: new Set([L0]), hotByKey, now: PT1_NOW, tier: "basic" });
    expect(basic.rows.map((r) => (r.kind === "not_opened" ? r.linkLabel : r.kind))).toEqual(["N6", "N5", "N4", "N3", "N2", "N1"]);
    expect(basic.more).toBe(0);

    const core = coreOf(AT2, { lastOpenedRows: [{ shareId: L0, lastMs: T0 + 3_300_000 }] });
    const resp = buildReadingResponse(core, { tier: "basic", days: 7, daysLimit: 7, shareId: null, matrixLimit: 25, now: PT1_NOW });
    expect(resp.attention).toEqual(basic);
  });

  test("people rows cap at 25 and count the rest; every unopened link follows them, oldest first", () => {
    const links = Array.from({ length: 30 }, (_, i) =>
      makeLink({ shareId: `many${String(i).padStart(2, "0")}`, label: `M${i}`, createdDate: new Date(PT1_NOW - (60 + i) * HOUR) }),
    );
    const basic = buildAttention({ people: [], links, openedShareIds: new Set(), hotByKey: new Map(), now: PT1_NOW, tier: "basic" });
    expect(basic.rows).toHaveLength(30);
    expect(basic.more).toBe(0);
    expect(basic.rows[0].kind === "not_opened" && basic.rows[0].linkLabel).toBe("M29");

    const active = Array.from({ length: 27 }, (_, i) => ({ ...A, key: `${A.key}-${i}`, personId: `${A.personId}-${i}`, lastEventAtMs: PT1_NOW - i * 1000 }));
    const deep = buildAttention({ people: active, links: links.slice(0, 2), openedShareIds: new Set(), hotByKey: new Map(), now: PT1_NOW, tier: "deep" });
    expect(deep.rows.map((r) => r.kind)).toEqual([...new Array(25).fill("active"), "not_opened", "not_opened"]);
    expect(deep.more).toBe(2);
  });

  test("a default link counts as not opened only when it is the doc's only non-archived link", () => {
    const def = makeLink({ shareId: "onlyDef1", label: "Default link", isDefault: true, createdDate: new Date(PT1_NOW - 60 * HOUR) });
    const archived = makeLink({ shareId: "archOld1", archivedAt: new Date(T0), createdDate: new Date(PT1_NOW - 90 * HOUR) });
    const alone = buildAttention({ people: [], links: [def, archived], openedShareIds: new Set(), hotByKey: new Map(), now: PT1_NOW, tier: "basic" });
    expect(alone.rows.map((r) => (r.kind === "not_opened" ? r.shareId : ""))).toEqual(["onlyDef1"]);
    const other = makeLink({ shareId: "other001", createdDate: new Date(PT1_NOW - 1 * HOUR) });
    const withOther = buildAttention({ people: [], links: [def, other], openedShareIds: new Set(), hotByKey: new Map(), now: PT1_NOW, tier: "basic" });
    expect(withOther.rows).toEqual([]);
  });
});
