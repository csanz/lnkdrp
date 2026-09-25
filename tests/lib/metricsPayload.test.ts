/**
 * A silent metrics refresh keeps the viewer rows it has (code review 2026-09-23, M23).
 */
import { describe, expect, it } from "vitest";

import { mergeSilentRefresh } from "../../src/lib/client/metricsPayload";

/** The payload shape as the page sees it: the merge only cares about the three row fields. */
type Payload = {
  ok: boolean;
  totals?: { views: number };
  viewers?: unknown[];
  anonymousViewers?: unknown[];
  projectLinkTraffic?: unknown;
};

const prev: Payload = {
  ok: true,
  totals: { views: 10 },
  viewers: [{ userId: "u1" }],
  anonymousViewers: [{ botIdHash: "b1" }],
  projectLinkTraffic: [{ shareId: "p1", name: "Jane" }],
};

describe("mergeSilentRefresh", () => {
  it("a first load takes the new payload as is", () => {
    const next: Payload = { ok: true, totals: { views: 11 }, viewers: [], anonymousViewers: [] };
    expect(mergeSilentRefresh(null, next, false)).toBe(next);
    expect(mergeSilentRefresh(prev, next, false)).toBe(next);
  });

  it("a silent refresh keeps the previous rows when the lite payload has none", () => {
    const next: Payload = { ok: true, totals: { views: 11 }, viewers: [], anonymousViewers: [] };
    const merged = mergeSilentRefresh(prev, next, true);
    expect(merged.totals).toEqual({ views: 11 });
    expect(merged.viewers).toBe(prev.viewers);
    expect(merged.anonymousViewers).toBe(prev.anonymousViewers);
    expect(merged.projectLinkTraffic).toBe(prev.projectLinkTraffic);
  });

  it("a silent refresh that carries rows replaces them", () => {
    const next: Payload = {
      ok: true,
      totals: { views: 12 },
      viewers: [{ userId: "u2" }],
      anonymousViewers: [],
      projectLinkTraffic: [{ shareId: "p1", name: null }],
    };
    const merged = mergeSilentRefresh(prev, next, true);
    expect(merged.viewers).toBe(next.viewers);
    // Empty in next, kept from prev: the follow-up viewers request is what empties a list.
    expect(merged.anonymousViewers).toBe(prev.anonymousViewers);
    // Present in next, taken: the counts are fresh even when the names are not.
    expect(merged.projectLinkTraffic).toBe(next.projectLinkTraffic);
  });

  it("nothing to keep: empty stays empty", () => {
    const empty: Payload = { ok: true, viewers: [], anonymousViewers: [] };
    const next: Payload = { ok: true, viewers: [], anonymousViewers: [] };
    expect(mergeSilentRefresh(empty, next, true)).toEqual(next);
  });
});
