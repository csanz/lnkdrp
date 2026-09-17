import type { PersonVisitRow } from "@/lib/analytics/reading/types";

/**
 * Visits that spent time on page 1. Every return lands on the cover, so when this is more than one
 * the page-1 total says more about coming back than about the page.
 */
export function coverTimedVisits(visits: PersonVisitRow[]): number {
  return visits.filter((v) => v.stops.some((s) => s.page === 1 && !s.passed && !s.untimed && s.ms > 0)).length;
}
