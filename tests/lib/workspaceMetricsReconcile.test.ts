/**
 * Reconciliation: the workspace metrics endpoint's per-document numbers must equal what the
 * document metrics endpoint computes for the same window (PRD, "Proposed decisions" 2 — if the two
 * disagree, the document page is right and this one has a bug).
 *
 * Database-backed, and skipped unless it is pointed at one: it reads a real workspace, because the
 * failure this guards against is a *scope* mistake (a deleted document's traffic, a viewer counted
 * per person instead of per link) that no fixture would show. The document-side figures below are
 * recomputed from the document-scoped matches — `{ docId }` instead of `{ orgId, docId: { $in } }`
 * — rather than read back from `query.ts`, so a wrong grouping there cannot pass by agreeing with
 * itself.
 *
 * "Document-scoped" means through `docOnlyShareIdMatch`, exactly as `/api/docs/:docId/shareviews`
 * builds it, and that is load-bearing rather than incidental: recomputing from a raw `{ docId }`
 * match made this suite pass against a workspace whose two live pages disagreed by six views,
 * because a raw match counts the data-room reads the workspace card was wrongly counting too. A
 * guard that models the page has to subtract the project slugs the page subtracts.
 *
 * Run it against the dev database with:
 *   MONGODB_URI="mongodb://127.0.0.1:27018/lnkdrp_dev?directConnection=true&replicaSet=rs0" \
 *   WORKSPACE_METRICS_TEST_ORG_ID=<orgId> \
 *   npx vitest run --config tests/lib/vitest.config.ts tests/lib/workspaceMetricsReconcile.test.ts
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  activityWindowMatch,
  LINK_VIEWER_KEY_EXPR,
  RECIPIENT_ONLY_MATCH,
  windowStartUtc,
} from "@/lib/analytics/shareViewAggregates";

const ORG_ID = (process.env.WORKSPACE_METRICS_TEST_ORG_ID ?? "").trim();

/** Both an org to read and a database to read it from, or the suite has nothing to reconcile. */
function canRun(): boolean {
  return Boolean(process.env.MONGODB_URI) && Boolean(ORG_ID);
}

/** How many of the workspace's top documents are checked. Three is the PRD's verification bar. */
const DOCS_TO_CHECK = 3;

describe("workspace metrics reconcile with document metrics", () => {
  afterAll(async () => {
    if (!canRun()) return;
    const mongoose = (await import("mongoose")).default;
    await mongoose.disconnect().catch(() => undefined);
  });

  it.skipIf(!canRun())(
    "top documents report the same views, viewers, reading time and downloads as their own pages",
    async () => {
      const { Types } = await import("mongoose");
      const { loadWorkspaceMetrics } = await import("@/lib/analytics/workspace/query");
      const { docOnlyShareIdMatch } = await import("@/lib/analytics/docScope");
      const { ShareViewModel } = await import("@/lib/models/ShareView");
      const { ShareVisitModel } = await import("@/lib/models/ShareVisit");

      const now = new Date();
      const payload = await loadWorkspaceMetrics({ orgId: ORG_ID, plan: "pro", requestedRange: "30d", now });
      const start = windowStartUtc(payload.range.days, now);
      const startKey = start.toISOString().slice(0, 10);

      const docs = payload.topDocs.slice(0, DOCS_TO_CHECK);
      expect(docs.length).toBeGreaterThan(0);

      for (const row of docs) {
        const docId = new Types.ObjectId(row.docId);
        // The document scope, exactly as `/api/docs/:docId/shareviews` builds it: `{ docId }`
        // *minus the project slugs this document has traffic on*, because a read through a data
        // room is the project's view and the document's own page never shows it.
        const { match: docOnlyMatch } = await docOnlyShareIdMatch([docId]);
        const scopeMatch = { docId, ...docOnlyMatch, ...RECIPIENT_ONLY_MATCH };
        const windowMatch = { ...scopeMatch, ...activityWindowMatch(start) };

        // The document route's `totals.opens` and `totals.visitTimeMs`: one row per tab session,
        // bounded by `lastEventAt`. Reading time is a range figure and must never come from the
        // lifetime `shareviews.timeSpentMs` counter, which is what this assertion pins.
        const visitMatch = { docId, ...docOnlyMatch, ...RECIPIENT_ONLY_MATCH, lastEventAt: { $gte: start } };

        const [views, viewerRows, downloadRows, opens, visitRows] = await Promise.all([
          ShareViewModel.countDocuments(windowMatch),
          ShareViewModel.aggregate([
            { $match: windowMatch },
            { $group: { _id: LINK_VIEWER_KEY_EXPR, timeSpentMs: { $sum: { $ifNull: ["$timeSpentMs", 0] } } } },
            { $group: { _id: null, viewers: { $sum: 1 }, timeSpentMs: { $sum: "$timeSpentMs" } } },
          ]),
          // Deliberately unwindowed, like the document route: this is the check that the workspace
          // route's `downloads: { $gt: 0 }` + window shortcut does not lose a download.
          ShareViewModel.aggregate([
            { $match: scopeMatch },
            { $project: { items: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
            { $unwind: "$items" },
            { $match: { "items.k": { $gte: startKey } } },
            { $group: { _id: null, downloads: { $sum: { $ifNull: ["$items.v", 0] } } } },
          ]),
          ShareVisitModel.countDocuments(visitMatch),
          ShareVisitModel.aggregate([
            { $match: visitMatch },
            { $group: { _id: null, ms: { $sum: { $ifNull: ["$timeSpentMs", 0] } } } },
          ]),
        ]);

        const viewers = Number(viewerRows[0]?.viewers ?? 0);
        const lifetimeTimeSpentMs = Number(viewerRows[0]?.timeSpentMs ?? 0);
        const visitTimeMs = Number(visitRows[0]?.ms ?? 0);
        const downloads = Number(downloadRows[0]?.downloads ?? 0);

        expect({
          docId: row.docId,
          views: row.views,
          viewers: row.viewers,
          opens: row.opens,
          readingTimeMs: row.readingTimeMs,
        }).toEqual({ docId: row.docId, views, viewers, opens, readingTimeMs: visitTimeMs });

        // The trap this page shipped once: the lifetime counter of the readers who happened to be
        // active in the window, reported as "reading time in the last 30 days".
        expect(row.readingTimeMs).toBeLessThanOrEqual(Math.max(lifetimeTimeSpentMs, visitTimeMs));

        // Downloads are not part of the document row, but the headline must not lose any either:
        // every download counted for this document in the window is in the workspace figure.
        expect(payload.headline.downloads.value).toBeGreaterThanOrEqual(downloads);
      }
    },
    30_000,
  );

  it.skipIf(!canRun())("the headline totals are the sum of the documents behind them", async () => {
    const { loadWorkspaceMetrics } = await import("@/lib/analytics/workspace/query");
    const payload = await loadWorkspaceMetrics({ orgId: ORG_ID, plan: "pro", requestedRange: "30d" });

    // The area under each series equals its headline figure — the invariant the chart relies on.
    expect(payload.series.reduce((a, p) => a + p.views, 0)).toBe(payload.headline.views.value);
    expect(payload.series.reduce((a, p) => a + p.opens, 0)).toBe(payload.headline.opens.value);
    expect(payload.series.reduce((a, p) => a + p.readingTimeMs, 0)).toBe(payload.headline.readingTimeMs.value);
    expect(payload.series.reduce((a, p) => a + p.downloads, 0)).toBe(payload.headline.downloads.value);
    expect(payload.series).toHaveLength(payload.range.days);
  });

  it.skipIf(!canRun())("a person's reading time is the window's, not their lifetime counter", async () => {
    const { loadWorkspaceMetrics } = await import("@/lib/analytics/workspace/query");
    const { ShareVisitModel } = await import("@/lib/models/ShareVisit");
    const { WORKSPACE_PERSON_KEY_EXPR, WORKSPACE_NAMED_ROW_MATCH } = await import("@/lib/analytics/workspace/match");

    const now = new Date();
    // 7 days on purpose: the shorter the window, the more of a lifetime counter falls outside it,
    // which is exactly the gap this assertion is here to catch.
    const payload = await loadWorkspaceMetrics({ orgId: ORG_ID, plan: "pro", requestedRange: "7d", now });
    if (!payload.people.items.length) return;

    const start = windowStartUtc(payload.range.days, now);
    const rows = (await ShareVisitModel.aggregate([
      { $match: { ...RECIPIENT_ONLY_MATCH, lastEventAt: { $gte: start } } },
      { $match: WORKSPACE_NAMED_ROW_MATCH },
      { $group: { _id: WORKSPACE_PERSON_KEY_EXPR, ms: { $sum: { $ifNull: ["$timeSpentMs", 0] } } } },
    ])) as Array<{ _id: string | null; ms: number }>;
    const msByKey = new Map(rows.filter((r) => r._id).map((r) => [String(r._id), Number(r.ms ?? 0)]));

    for (const person of payload.people.items) {
      // `toBeLessThanOrEqual`, not equality: the aggregate above is org-wide (it cannot cheaply
      // rebuild the live-document scope), so it can only be a ceiling. A lifetime figure would
      // break through it, which is the regression being pinned.
      expect(person.readingTimeMs).toBeLessThanOrEqual(msByKey.get(person.key) ?? 0);
    }
    // And the card can never total more than the tile it sits under.
    const total = payload.people.items.reduce((a, p) => a + p.readingTimeMs, 0);
    expect(total).toBeLessThanOrEqual(payload.headline.readingTimeMs.value);
  });

  it.skipIf(!canRun())("returning readers are counted, never derived from opens minus views", async () => {
    const { loadWorkspaceMetrics } = await import("@/lib/analytics/workspace/query");
    const payload = await loadWorkspaceMetrics({ orgId: ORG_ID, plan: "pro", requestedRange: "30d" });
    const returning = payload.docsOpened.returningReaders;
    if (returning === null) return;

    // A reader who came back is a reader, so there cannot be more of them than there were readers;
    // `opens - views` has no such bound and ran 1.7x this figure on the seed workspace.
    expect(returning).toBeLessThanOrEqual(payload.headline.views.value);
    expect(returning).toBeLessThanOrEqual(payload.headline.opens.value);
  });

  it.skipIf(!canRun())("Free withholds every identity and its history beyond the plan window", async () => {
    const { loadWorkspaceMetrics } = await import("@/lib/analytics/workspace/query");
    const { FREE_ANALYTICS_DAYS } = await import("@/lib/billing/planLimits");
    const payload = await loadWorkspaceMetrics({ orgId: ORG_ID, plan: "free", requestedRange: "90d" });

    expect(payload.range.days).toBe(FREE_ANALYTICS_DAYS);
    expect(payload.range.clampedByPlan).toBe(true);
    expect(payload.people.items).toEqual([]);
    expect(payload.people.gated).toBe(true);
    // Not one name or email anywhere in the payload, whatever the rows hold.
    expect(JSON.stringify(payload)).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
