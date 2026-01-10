/**
 * API route for `/api/dashboard/stats` — overview stats for the dashboard Overview tab.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { ShareViewModel } from "@/lib/models/ShareView";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      const rangeDays = 30;
      const { start: since30d, keys: dayKeys30d } = buildLastNDaysKeys(rangeDays);
      const since7d = new Date(since30d);
      since7d.setUTCDate(since30d.getUTCDate() + (rangeDays - 7));

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
        { $match: { $or: [{ createdDate: { $gte: since30d } }, { updatedDate: { $gte: since30d } }] } },
        // Keep the working set small: we only need docId + dates + downloadsByDay for the dashboard series.
        { $project: { docId: 1, createdDate: 1, updatedDate: 1, downloadsByDay: 1 } },
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
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


