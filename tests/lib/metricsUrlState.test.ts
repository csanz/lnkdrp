import { describe, expect, it } from "vitest";

import { parseMetricsUrl, serializeMetricsUrl, type MetricsUrlState } from "@/components/metrics/metricsUrlState";

const HASH = "a".repeat(64);
const PERSON = `9shfC3ivIFTm.a.${HASH}`;
const USER_PERSON = `Seq_uoia-1.u.${"0123456789abcdef01234567"}`;

function sp(qs: string) {
  return new URLSearchParams(qs);
}

describe("parseMetricsUrl", () => {
  it("maps each range to days", () => {
    expect(parseMetricsUrl(sp("range=7d"), "deep").days).toBe(7);
    expect(parseMetricsUrl(sp("range=30d"), "deep").days).toBe(30);
    expect(parseMetricsUrl(sp("range=90d"), "deep").days).toBe(90);
    expect(parseMetricsUrl(sp("range=12m"), "deep").days).toBe(365);
  });

  it("defaults to 30 days on deep or unknown tier", () => {
    expect(parseMetricsUrl(sp(""), "deep").days).toBe(30);
    expect(parseMetricsUrl(sp(""), null).days).toBe(30);
    expect(parseMetricsUrl(sp("range=12m"), null).days).toBe(365);
  });

  it("always uses 7 days on basic", () => {
    expect(parseMetricsUrl(sp(""), "basic").days).toBe(7);
    expect(parseMetricsUrl(sp("range=90d"), "basic").days).toBe(7);
    expect(parseMetricsUrl(sp("range=12m"), "basic").days).toBe(7);
  });

  it("falls back on invalid ranges", () => {
    expect(parseMetricsUrl(sp("range=15d"), "deep").days).toBe(30);
    expect(parseMetricsUrl(sp("range=abc"), null).days).toBe(30);
    expect(parseMetricsUrl(sp("range=30"), "basic").days).toBe(7);
  });

  it("accepts only well-formed share ids", () => {
    expect(parseMetricsUrl(sp("shareId=9shfC3ivIFTm"), "deep").shareId).toBe("9shfC3ivIFTm");
    expect(parseMetricsUrl(sp("shareId=abc"), "deep").shareId).toBeNull();
    expect(parseMetricsUrl(sp("shareId=a.b.c.d"), "deep").shareId).toBeNull();
    expect(parseMetricsUrl(sp(""), "deep").shareId).toBeNull();
  });

  it("accepts only decodable person ids", () => {
    expect(parseMetricsUrl(sp(`person=${PERSON}`), "deep").personId).toBe(PERSON);
    expect(parseMetricsUrl(sp(`person=${USER_PERSON}`), "deep").personId).toBe(USER_PERSON);
    expect(parseMetricsUrl(sp("person=a%40b.com"), "deep").personId).toBeNull();
    expect(parseMetricsUrl(sp(`person=9shfC3ivIFTm.a.${"a".repeat(63)}`), "deep").personId).toBeNull();
  });
});

describe("serializeMetricsUrl", () => {
  it("omits the default range", () => {
    expect(serializeMetricsUrl({ shareId: null, days: 30, personId: null }, "deep")).toBe("");
    expect(serializeMetricsUrl({ shareId: null, days: 30, personId: null }, null)).toBe("");
    expect(serializeMetricsUrl({ shareId: null, days: 7, personId: null }, "basic")).toBe("");
  });

  it("writes non-default ranges", () => {
    expect(serializeMetricsUrl({ shareId: null, days: 7, personId: null }, "deep")).toBe("?range=7d");
    expect(serializeMetricsUrl({ shareId: null, days: 365, personId: null }, "deep")).toBe("?range=12m");
  });

  it("never writes a range on basic", () => {
    expect(serializeMetricsUrl({ shareId: null, days: 90, personId: null }, "basic")).toBe("");
  });

  it("drops invalid share and person ids", () => {
    expect(serializeMetricsUrl({ shareId: "x", days: 30, personId: "a@b.com" }, "deep")).toBe("");
  });

  it("round-trips", () => {
    const states: Array<[MetricsUrlState, "deep" | "basic" | null]> = [
      [{ shareId: "9shfC3ivIFTm", days: 90, personId: PERSON }, "deep"],
      [{ shareId: null, days: 365, personId: USER_PERSON }, null],
      [{ shareId: "2LFdEs9V4eeN", days: 7, personId: null }, "basic"],
      [{ shareId: null, days: 30, personId: null }, "deep"],
    ];
    for (const [state, tier] of states) {
      const qs = serializeMetricsUrl(state, tier);
      expect(parseMetricsUrl(new URLSearchParams(qs.replace(/^\?/, "")), tier)).toEqual(state);
    }
  });
});
