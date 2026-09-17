/**
 * URL state for the document metrics page: `?range=7d|30d|90d|12m`, `?shareId=`, `?person=`.
 * Pure, so the mapping rules are unit-tested without a router.
 */
import { decodePersonId } from "@/lib/analytics/reading/identity";
import type { ReadingTier } from "@/lib/analytics/reading/types";

export type MetricsDays = 7 | 30 | 90 | 365;

export type MetricsUrlState = { shareId: string | null; days: MetricsDays; personId: string | null };

/** Anything with a `get`, such as `URLSearchParams` or Next's `ReadonlyURLSearchParams`. */
export type SearchParamsLike = { get(name: string): string | null };

const RANGE_TO_DAYS: Record<string, MetricsDays> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };
const DAYS_TO_RANGE: Record<MetricsDays, string> = { 7: "7d", 30: "30d", 90: "90d", 365: "12m" };
const SHARE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** Default range for a tier: Free (basic) only has 7 days; deep or not yet known starts at 30. */
export function defaultMetricsDays(tier: ReadingTier | null): MetricsDays {
  return tier === "basic" ? 7 : 30;
}

/** Read the page state from the query string. Invalid values fall back to defaults. */
export function parseMetricsUrl(sp: SearchParamsLike, tier: ReadingTier | null): MetricsUrlState {
  const rawRange = sp.get("range")?.trim() ?? "";
  const days: MetricsDays = tier === "basic" ? 7 : (RANGE_TO_DAYS[rawRange] ?? defaultMetricsDays(tier));
  const rawShare = sp.get("shareId")?.trim() ?? "";
  const shareId = SHARE_ID_RE.test(rawShare) ? rawShare : null;
  const rawPerson = sp.get("person")?.trim() ?? "";
  const personId = decodePersonId(rawPerson) ? rawPerson : null;
  return { shareId, days, personId };
}

/** Build `?range=…&shareId=…&person=…` (or "" when everything is default). */
export function serializeMetricsUrl(s: MetricsUrlState, tier: ReadingTier | null): string {
  const params = new URLSearchParams();
  const days = tier === "basic" ? 7 : s.days;
  if (days !== defaultMetricsDays(tier) && DAYS_TO_RANGE[days]) params.set("range", DAYS_TO_RANGE[days]);
  if (s.shareId && SHARE_ID_RE.test(s.shareId)) params.set("shareId", s.shareId);
  if (s.personId && decodePersonId(s.personId)) params.set("person", s.personId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
