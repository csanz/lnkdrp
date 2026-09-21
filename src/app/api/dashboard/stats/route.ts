/**
 * API route for `/api/dashboard/stats` — overview stats for the dashboard Overview tab.
 */
import { NextResponse } from "next/server";
import { errorJson } from "@/lib/http/errorResponse";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { ShareViewModel } from "@/lib/models/ShareView";
import { RECIPIENT_ONLY_MATCH } from "@/lib/analytics/shareViewAggregates";
import { workspaceOrgMatch } from "@/lib/analytics/workspace/match";
import { clampAnalyticsDays, getWorkspacePlan } from "@/lib/billing/planLimits";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The window this tab asks for before the plan has its say. Pro gets all 30 days; Free is clamped
 * to `FREE_ANALYTICS_DAYS` like every other analytics surface — see the note on `rangeDays` below.
 */
const DASHBOARD_RANGE_DAYS = 30;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDayKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildLastNDaysKeys(n: number): { start: Date; keys: string[] } {
  const end = utcDayStart(new Date());
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - (n - 1));
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    keys.push(utcDayKey(d));
  }
  return { start, keys };
}

/**
 * Scope note for the two `sharing` view counters below.
 *
 * `viewsTotal` / `views30d` / `pagesViewedTotal` / `pagesViewed30d` are sums of `Doc.numberOfViews`
 * and `Doc.numberOfPagesViewed` — per-document legacy counters, and therefore **document-scoped**:
 * a read through a project link is the data room's view and moves neither of them
 * (`@/lib/analytics/docScope`, docs/METRICS.md). The four tiles agree with each other and with the
 * document pages they summarise, and under-count a workspace that shares through data rooms.
 *
 * That agreement holds from the ingest guard forwards and *not* over history: a data-room read
 * taken before the guard is inside the stored counter for good, and no later traffic subtracts it.
 * A workspace in that state showed 14 here against 7 on both of its documents' own pages. The
 * repair is `scripts/doc-view-counters-recount.ts`, which rewrites both counters from the analytics
 * rows under the same rule; run it once per environment (and after any pass that reclassifies
 * rows). Until it has run on an environment, treat these four tiles there as contaminated by
 * pre-guard project-link traffic rather than as the document-scoped figures they now are.
 *
 * The `series30d` chart beside them is built from `ShareView` rows, which carry every read, so the
 * chart can legitimately run above the tiles on such a workspace. `/api/metrics/workspace` is the
 * surface that answers the workspace-scoped question properly; this one is the Overview tab's
 * cheap summary and is not worth re-deriving here.
 *
 * "Cheap" was an aspiration and not a fact until now: the `ShareView` stage below opened with a
 * `$match` carrying no tenant predicate, so every Overview load read *every* workspace's views for
 * the window and only dropped the other tenants' rows after a per-row `$lookup` into `docs`. One
 * customer's dashboard cost work proportional to every customer's traffic. The tenant predicate is
 * now in the first `$match` — see the stage itself.
 */
export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (!Types.ObjectId.isValid(actor.orgId)) {
        return NextResponse.json({ error: "Invalid org" }, { status: 400 });
      }

      const orgId = new Types.ObjectId(actor.orgId);

      await connectMongo();

      const now = new Date();

      /**
       * The served window, after the plan has had its say.
       *
       * This used to be a hard-coded 30 with no plan read anywhere in the file, and it made the
       * Overview tab the one surface that gave a Free workspace a month of view history: /metrics
       * clamps to `FREE_ANALYTICS_DAYS` and says so with `range.clampedByPlan`, every per-document
       * analytics route clamps identically, the pricing page sells Free as "last 7 days" and the
       * upgrade modal sells Pro as "the full history, not just 7 days". So the dashboard was giving
       * away the thing the upsell is selling, and two surfaces disagreed about the same workspace.
       *
       * The clamp covers the whole payload, not just the view series: the chart plots uploads, docs
       * created, views and downloads on one x-axis, and a 30-day upload line beside a 7-day view
       * line would be a chart nobody can read. `range` below reports the window that was actually
       * served so the client can label it honestly instead of asserting "Last 30 days".
       */
      const plan = await getWorkspacePlan(orgId);
      const rangeDays = clampAnalyticsDays(plan, DASHBOARD_RANGE_DAYS);
      const clampedByPlan = rangeDays < DASHBOARD_RANGE_DAYS;
      const { start: since30d, keys: dayKeys30d } = buildLastNDaysKeys(rangeDays);
      // The inner 7-day mark, which cannot start before the window itself once Free is clamped to 7.
      const since7d = new Date(since30d);
      since7d.setUTCDate(since30d.getUTCDate() + Math.max(0, rangeDays - 7));

      const docActiveMatch = { orgId, isDeleted: { $ne: true }, isArchived: { $ne: true } };

    const [
      docAggArr,
      projAggArr,
      uploadsByDay30d,
      shareAggArr,
    ] = await Promise.all([
      DocModel.aggregate([
        { $match: docActiveMatch },
        {
          $facet: {
            countsAndSharing: [
              {
                $group: {
                  _id: null,
                  docsActive: { $sum: 1 },
                  docsCreated30d: { $sum: { $cond: [{ $gte: ["$createdDate", since30d] }, 1, 0] } },
                  viewsTotal: { $sum: { $ifNull: ["$numberOfViews", 0] } },
                  pagesViewedTotal: { $sum: { $ifNull: ["$numberOfPagesViewed", 0] } },
                  views30d: {
                    $sum: {
                      $cond: [{ $gte: ["$createdDate", since30d] }, { $ifNull: ["$numberOfViews", 0] }, 0],
                    },
                  },
                  pagesViewed30d: {
                    $sum: {
                      $cond: [{ $gte: ["$createdDate", since30d] }, { $ifNull: ["$numberOfPagesViewed", 0] }, 0],
                    },
                  },
                },
              },
            ],
            docsByDay30d: [
              { $match: { createdDate: { $gte: since30d } } },
              { $project: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } } } },
              { $group: { _id: "$day", count: { $sum: 1 } } },
            ],
          },
        },
      ]),
      ProjectModel.aggregate([
        { $match: { orgId, isDeleted: { $ne: true } } },
        {
          $group: {
            _id: null,
            projectsActive: { $sum: { $cond: ["$isRequest", 0, 1] } },
            requestsActive: { $sum: { $cond: ["$isRequest", 1, 0] } },
          },
        },
      ]),
      UploadModel.aggregate([
        { $match: { orgId, isDeleted: { $ne: true }, createdDate: { $gte: since30d } } },
        { $project: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } } } },
        { $group: { _id: "$day", count: { $sum: 1 } } },
      ]),
      ShareViewModel.aggregate([
        // Recipients only, like every other view figure in the product: the workspace dashboard
        // must not be the one surface where the team's own opens inflate the chart.
        //
        // The tenant predicate belongs HERE, in the first stage. Without it the `$or` over two date
        // fields is servable by no index, so Mongo read the whole `ShareView` collection — every
        // workspace's traffic — and handed it to the `$lookup` below to sort out. `ShareView`
        // denormalizes `orgId` for exactly this question and carries `{ orgId: 1, createdDate: -1 }`
        // to serve it; the stats heartbeat `$set`s it on every row it touches.
        //
        // `workspaceOrgMatch` rather than a plain `{ orgId }` equality, for the reason it documents:
        // rows written before the field existed default to `null` until
        // `scripts/sharelinks-analytics-backfill.ts` has run on the environment, and dropping them
        // would silently under-report a workspace's own chart against the document pages beside it.
        { $match: { ...workspaceOrgMatch(orgId), ...RECIPIENT_ONLY_MATCH, $or: [{ createdDate: { $gte: since30d } }, { updatedDate: { $gte: since30d } }] } },
        // Keep the working set small: we only need docId + dates + downloadsByDay for the dashboard series.
        { $project: { docId: 1, createdDate: 1, updatedDate: 1, downloadsByDay: 1 } },
        // The `$lookup` stays, and is not redundant with the `$match` above: it is what keeps the
        // `orgId: null` legacy branch inside this tenant, and it is the only thing that drops views
        // of deleted documents (`isDeleted`, which `ShareView` does not denormalize).
        {
          $lookup: {
            from: "docs",
            let: { docId: "$docId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$_id", "$$docId"] },
                      { $eq: ["$orgId", orgId] },
                      { $ne: ["$isDeleted", true] },
                    ],
                  },
                },
              },
              // IMPORTANT: avoid pulling large doc fields (extractedText, aiOutput, etc) into this aggregation.
              { $project: { _id: 1 } },
            ],
            as: "doc",
          },
        },
        { $unwind: "$doc" },
        {
          $facet: {
            viewsByDay: [
              { $match: { createdDate: { $gte: since30d } } },
              { $project: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } } } },
              { $group: { _id: "$day", count: { $sum: 1 } } },
            ],
            downloadsByDay: [
              { $match: { updatedDate: { $gte: since30d } } },
              { $project: { pairs: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } } } },
              { $unwind: "$pairs" },
              { $match: { "pairs.k": { $gte: utcDayKey(since30d) } } },
              { $group: { _id: "$pairs.k", downloads: { $sum: "$pairs.v" } } },
            ],
          },
        },
      ]),
    ]);

    const docAgg = Array.isArray(docAggArr) && docAggArr[0] ? (docAggArr[0] as any) : null;
    const countsRow = Array.isArray(docAgg?.countsAndSharing) && docAgg.countsAndSharing[0] ? docAgg.countsAndSharing[0] : null;
    const docsByDay30d = Array.isArray(docAgg?.docsByDay30d) ? (docAgg.docsByDay30d as any[]) : [];

    const projRow = Array.isArray(projAggArr) && projAggArr[0] ? (projAggArr[0] as any) : null;

    const shareAgg = Array.isArray(shareAggArr) && shareAggArr[0] ? (shareAggArr[0] as any) : null;
    const shareViewsByDay30d = Array.isArray(shareAgg?.viewsByDay) ? (shareAgg.viewsByDay as any[]) : [];
    const shareDownloadsByDay30d = Array.isArray(shareAgg?.downloadsByDay) ? (shareAgg.downloadsByDay as any[]) : [];

      function toCountMap(rows: unknown[]): Map<string, number> {
        const m = new Map<string, number>();
        if (!Array.isArray(rows)) return m;
        for (const r of rows) {
          const row = r as any;
          const k = typeof row?._id === "string" ? row._id : "";
          const v =
            typeof row?.count === "number"
              ? row.count
              : typeof row?.downloads === "number"
                ? row.downloads
                : null;
          if (k && typeof v === "number") m.set(k, v);
        }
        return m;
      }

      const docsByDayMap = toCountMap(docsByDay30d);
      const uploadsByDayMap = toCountMap(uploadsByDay30d);
      const shareViewsByDayMap = toCountMap(shareViewsByDay30d);
      const shareDownloadsByDayMap = toCountMap(shareDownloadsByDay30d);

      const series30d = dayKeys30d.map((day) => ({
        day,
        docsCreated: docsByDayMap.get(day) ?? 0,
        uploadsCreated: uploadsByDayMap.get(day) ?? 0,
        shareUniqueViews: shareViewsByDayMap.get(day) ?? 0,
        shareDownloads: shareDownloadsByDayMap.get(day) ?? 0,
      }));

      // Keep this payload stable and simple for the client.
      return NextResponse.json(
        {
        ok: true,
        generatedAt: now.toISOString(),
        window: {
          days7Start: since7d.toISOString(),
          days30Start: since30d.toISOString(),
        },
        /**
         * The window that was actually served, in the shape `/api/metrics/workspace` uses
         * (`range.days` / `range.clampedByPlan`). Every `*30d` key below — including `series30d`,
         * whose name is the client's contract and so stays — covers `range.days` days, not always
         * 30, so the client must label the chart and the tiles from this and never from the literal
         * "Last 30 days".
         */
        range: {
          days: rangeDays,
          start: dayKeys30d[0] ?? utcDayKey(since30d),
          end: dayKeys30d[dayKeys30d.length - 1] ?? utcDayKey(since30d),
          clampedByPlan,
        },
        series30d,
        docs: {
          active: typeof countsRow?.docsActive === "number" ? countsRow.docsActive : 0,
          created30d: typeof countsRow?.docsCreated30d === "number" ? countsRow.docsCreated30d : 0,
        },
        projects: {
          active: typeof projRow?.projectsActive === "number" ? projRow.projectsActive : 0,
          requests: typeof projRow?.requestsActive === "number" ? projRow.requestsActive : 0,
        },
        uploads: {
          created30d: uploadsByDayMap.size ? Array.from(uploadsByDayMap.values()).reduce((s, n) => s + n, 0) : 0,
        },
        sharing: {
          viewsTotal: typeof countsRow?.viewsTotal === "number" ? countsRow.viewsTotal : 0,
          pagesViewedTotal: typeof countsRow?.pagesViewedTotal === "number" ? countsRow.pagesViewedTotal : 0,
          views30d: typeof countsRow?.views30d === "number" ? countsRow.views30d : 0,
          pagesViewed30d: typeof countsRow?.pagesViewed30d === "number" ? countsRow.pagesViewed30d : 0,
        },
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      // A caught failure here is ours, not the caller's: the raw message went straight to the
      // browser (Mongo and Stripe internals included) and nothing reached the logs. `errorJson`
      // redacts, logs one line always, and keeps `detail` for non-production.
      return errorJson(err, { status: 500, publicMessage: "Could not load dashboard stats.", context: "[api/dashboard/stats] GET failed" });
    }
  });
}


