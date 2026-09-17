import { describe, expect, it } from "vitest";

import { linkLeaders } from "@/components/metrics/pageEmphasis";
import type { LinkRow } from "@/lib/analytics/reading/types";

function link(shareId: string, peopleWithDetail: number, reachedEnd: number, medianTotalMs: number | null): LinkRow {
  return {
    shareId,
    label: shareId,
    isDefault: false,
    status: "active",
    createdAt: null,
    people: peopleWithDetail,
    lastOpenedAt: null,
    everOpened: true,
    lastOpenedAtAllTime: null,
    reachedEnd,
    peopleWithDetail,
    medianTotalMs,
  };
}

describe("linkLeaders", () => {
  const comparable = [link("a", 5, 5, 53_000), link("b", 6, 3, 30_000), link("c", 8, 2, 20_000)];

  it("bolds a clear leader among links with enough people", () => {
    expect(linkLeaders(comparable)).toEqual({ end: "a", typical: "a" });
  });

  it("drops the typical leader when a thin link shows a longer time", () => {
    expect(linkLeaders([...comparable, link("thin", 3, 1, 80_000)])).toEqual({ end: "a", typical: null });
  });

  it("drops the reached-end leader when a thin link shows a higher share", () => {
    const leader = [link("a", 10, 8, 53_000), comparable[1], comparable[2]];
    expect(linkLeaders([...leader, link("thin", 2, 2, 10_000)])).toEqual({ end: null, typical: "a" });
  });

  it("ignores links with no page detail", () => {
    expect(linkLeaders([...comparable, link("empty", 0, 0, null)])).toEqual({ end: "a", typical: "a" });
  });
});
