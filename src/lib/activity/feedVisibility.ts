/**
 * Which activity rows the workspace feed shows when nobody asked for a type.
 *
 * Some rows are instrumentation, not history: the funnel events (`funnel.*`, `checkout.started`,
 * see docs/reviews/pricing-upsell-fix-plan-2026-09-23.md Phase 4) exist so the admin funnel can
 * count workspaces at each step, and a feature-gate refusal (`plan.limit_reached` on
 * `version_history`, `analytics_history`, `project_links`) is a Free workspace opening a page it is
 * not entitled to, which happens on every metrics load and says nothing anyone did. Showing them
 * would put "you saw the upgrade prompt" between the uploads and the shares.
 *
 * The counted caps (`documents`, `projects`, `collaborators`, `team_workspaces`) stay visible: a
 * refused write is a thing that happened to the workspace, and the feed has said so since launch.
 *
 * Pure, so the feed route and any test can share the one rule. An explicit `type=` filter is a
 * request for exactly those rows and bypasses this.
 */
import type { ActivityType } from "@/lib/activity/log";

/** Types never shown without an explicit type filter. */
export const FEED_HIDDEN_TYPES: readonly ActivityType[] = [
  "funnel.modal_shown",
  "funnel.cta_clicked",
  "funnel.teaser_shown",
  "checkout.started",
];

/** `plan.limit_reached` rows whose `meta.limit` is one of these are hidden too. */
export const FEED_HIDDEN_LIMIT_KEYS: readonly string[] = ["version_history", "analytics_history", "project_links"];

/**
 * Mongo clauses that exclude the hidden rows, to spread into the feed's filter as `$nor`.
 * Returns a fresh array each call so a caller may push its own clauses.
 */
export function feedHiddenClauses(): Array<Record<string, unknown>> {
  return [
    { type: { $in: [...FEED_HIDDEN_TYPES] } },
    { type: "plan.limit_reached", "meta.limit": { $in: [...FEED_HIDDEN_LIMIT_KEYS] } },
  ];
}

/** Pure form of the same rule, for a row already in hand. */
export function isHiddenFromFeed(row: { type: string; meta?: Record<string, unknown> | null }): boolean {
  if ((FEED_HIDDEN_TYPES as readonly string[]).includes(row.type)) return true;
  if (row.type !== "plan.limit_reached") return false;
  const limit = row.meta && typeof row.meta.limit === "string" ? row.meta.limit : "";
  return FEED_HIDDEN_LIMIT_KEYS.includes(limit);
}
