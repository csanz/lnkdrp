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
  makeLink,
  peopleOf,
  personOf,
} from "./fixtures/readingFixtures";

describe("computeHot", () => {
  test("F1 alone on a 4-page doc: stayed on all pages", () => {
    const hot = computeHot(peopleOf(F1), 4);
    const r = hot.get(F1.keys[0]);
    expect(r).toEqual({ kind: "read_most", read: 4, pageCount: 4 });
    expect(hotReasonText(r!)).toBe("Stayed on 4 of 4 pages");
  });

  test("F6 returner", () => {
    const p = personOf(F6);
    expect(largestReturnGap(p)).toBe(70 * HOUR - 50_000);
    expect(computeHot([p], 6).get(p.key)).toEqual({ kind: "returned", gapMs: 70 * HOUR - 50_000 });
  });

  test("PT1", () => {
    const hot = computeHot(peopleOf(PT1), 4);
    const [A, B, C, D, E] = PT1.keys;
    expect(hot.get(A)).toEqual({ kind: "read_most", read: 4, pageCount: 4 });
    expect(hot.get(B)).toEqual({ kind: "dwell", page: 3, ratio: 2.8 });
    expect(hot.get(C)).toBeNull();
    expect(hot.get(D)).toEqual({ kind: "dwell", page: 2, ratio: 5.7 });
    expect(hot.get(E)).toBeNull();
  });

  test("SR1 alone, with two peers, with three peers", () => {
    expect(computeHot(peopleOf(SR1), 4).get(SR1.keys[0])).toBeNull();
    expect(computeHot(peopleOf(SR2), 4).get(SR2.keys[0])).toBeNull();
    const r = computeHot(peopleOf(SR3), 4).get(SR3.keys[0]);
    expect(r).toEqual({ kind: "dwell", page: 2, ratio: 10 });
    expect(hotReasonText(r!)).toBe("Spent 10.0× the typical page time on page 2");
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
  test("exact strings", () => {
    expect(hotReasonText({ kind: "returned", gapMs: 70 * 3_600_000 })).toBe("Came back 2 days later");
    expect(hotReasonText({ kind: "dwell", page: 2, ratio: 5.7 })).toBe("Spent 5.7× the typical page time on page 2");
    expect(hotReasonText({ kind: "read_most", read: 3, pageCount: 4 })).toBe("Stayed on 3 of 4 pages");
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
  const [A, B, , D] = people;

  test("AT1 deep", () => {
    const out = buildAttention({ people, links: AT1.links, openedShareIds: new Set([L0]), hotByKey, now: PT1_NOW, tier: "deep" });
    expect(out.more).toBe(0);
    expect(out.rows).toEqual([
      { kind: "active", personId: A.personId, name: A.name, linkLabel: "Default link", page: 4, at: new Date(T0 + 3_300_000).toISOString() },
      { kind: "hot", personId: D.personId, name: D.name, linkLabel: "Default link", reason: { kind: "dwell", page: 2, ratio: 5.7 } },
      { kind: "hot", personId: B.personId, name: B.name, linkLabel: "Default link", reason: { kind: "dwell", page: 3, ratio: 2.8 } },
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
      `hot:${D.personId}`,
      `hot:${B.personId}`,
      "N6",
      "N5",
    ]);
    expect(deep.more).toBe(4);

    const basic = buildAttention({ people, links: AT2.links, openedShareIds: new Set([L0]), hotByKey, now: PT1_NOW, tier: "basic" });
    expect(basic.rows.map((r) => (r.kind === "not_opened" ? r.linkLabel : r.kind))).toEqual(["N6", "N5", "N4", "N3", "N2"]);
    expect(basic.more).toBe(1);

    const core = coreOf(AT2, { lastOpenedRows: [{ shareId: L0, lastMs: T0 + 3_300_000 }] });
    const resp = buildReadingResponse(core, { tier: "basic", days: 7, daysLimit: 7, shareId: null, matrixLimit: 25, now: PT1_NOW });
    expect(resp.attention).toEqual(basic);
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
