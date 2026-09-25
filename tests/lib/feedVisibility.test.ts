/**
 * The workspace feed hides instrumentation rows unless a type filter names them
 * (`src/lib/activity/feedVisibility.ts`).
 */
import { describe, expect, it } from "vitest";

import { feedHiddenClauses, isHiddenFromFeed } from "@/lib/activity/feedVisibility";

describe("feed visibility", () => {
  it("hides funnel rows and Checkout starts", () => {
    expect(isHiddenFromFeed({ type: "funnel.modal_shown" })).toBe(true);
    expect(isHiddenFromFeed({ type: "funnel.cta_clicked" })).toBe(true);
    expect(isHiddenFromFeed({ type: "funnel.teaser_shown" })).toBe(true);
    expect(isHiddenFromFeed({ type: "checkout.started" })).toBe(true);
  });

  it("hides a feature-gate refusal and keeps a counted-cap refusal", () => {
    expect(isHiddenFromFeed({ type: "plan.limit_reached", meta: { limit: "analytics_history" } })).toBe(true);
    expect(isHiddenFromFeed({ type: "plan.limit_reached", meta: { limit: "version_history" } })).toBe(true);
    expect(isHiddenFromFeed({ type: "plan.limit_reached", meta: { limit: "documents" } })).toBe(false);
    expect(isHiddenFromFeed({ type: "plan.limit_reached", meta: { limit: "collaborators" } })).toBe(false);
    expect(isHiddenFromFeed({ type: "plan.limit_reached" })).toBe(false);
  });

  it("keeps everything else", () => {
    expect(isHiddenFromFeed({ type: "doc.created" })).toBe(false);
    expect(isHiddenFromFeed({ type: "plan.upgraded" })).toBe(false);
    expect(isHiddenFromFeed({ type: "credits.exhausted" })).toBe(false);
  });

  it("the Mongo clauses say the same thing", () => {
    const clauses = feedHiddenClauses();
    expect(clauses).toEqual([
      { type: { $in: ["funnel.modal_shown", "funnel.cta_clicked", "funnel.teaser_shown", "checkout.started"] } },
      { type: "plan.limit_reached", "meta.limit": { $in: ["version_history", "analytics_history", "project_links"] } },
    ]);
  });
});
