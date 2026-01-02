/**
 * API route for `/api/dashboard/stats` — overview stats for the dashboard Overview tab.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { ShareViewModel } from "@/lib/models/ShareView";

export const runtime = "nodejs";

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
  const actor = await resolveActor(request);
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

    const [docsActive, docsCreated30d, shareAgg, projectsActive, requestsActive, uploads30d, docsByDay30d, uploadsByDay30d] =
      await Promise.all([
      DocModel.countDocuments(docActiveMatch),
      DocModel.countDocuments({ ...docActiveMatch, createdDate: { $gte: since30d } }),
      DocModel.aggregate([
        { $match: docActiveMatch },
        {
          $group: {
            _id: null,
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
      ]),
      ProjectModel.countDocuments({ orgId, isDeleted: { $ne: true }, isRequest: { $ne: true } }),
      ProjectModel.countDocuments({ orgId, isDeleted: { $ne: true }, isRequest: true }),
      UploadModel.countDocuments({ orgId, isDeleted: { $ne: true }, createdDate: { $gte: since30d } }),
      DocModel.aggregate([
        { $match: { ...docActiveMatch, createdDate: { $gte: since30d } } },
        { $project: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } } } },
        { $group: { _id: "$day", count: { $sum: 1 } } },
      ]),
      UploadModel.aggregate([
        { $match: { orgId, isDeleted: { $ne: true }, createdDate: { $gte: since30d } } },
        { $project: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } } } },
        { $group: { _id: "$day", count: { $sum: 1 } } },
      ]),
    ]);

    const shareRow = Array.isArray(shareAgg) && shareAgg[0] ? (shareAgg[0] as any) : null;

    const startKey = utcDayKey(since30d);
    const [shareViewsByDay30d, shareDownloadsByDay30d] = await Promise.all([
      // Approximation: unique share viewers by day (first-seen viewer records).
      ShareViewModel.aggregate([
        { $match: { createdDate: { $gte: since30d } } },
        {
          $lookup: {
            from: "docs",
            localField: "docId",
            foreignField: "_id",
            as: "doc",
          },
        },
        { $unwind: "$doc" },
        { $match: { "doc.orgId": orgId, "doc.isDeleted": { $ne: true } } },
        { $project: { day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } } } },
        { $group: { _id: "$day", count: { $sum: 1 } } },
      ]),

      // Downloads by UTC day (map field), filtered to last 30 days.
      ShareViewModel.aggregate([
        { $match: { updatedDate: { $gte: since30d } } },
        {
          $lookup: {
            from: "docs",
            localField: "docId",
            foreignField: "_id",
            as: "doc",
          },
        },
        { $unwind: "$doc" },
        { $match: { "doc.orgId": orgId, "doc.isDeleted": { $ne: true } } },
        {
          $project: {
            pairs: { $objectToArray: { $ifNull: ["$downloadsByDay", {}] } },
          },
        },
        { $unwind: "$pairs" },
        { $match: { "pairs.k": { $gte: startKey } } },
        { $group: { _id: "$pairs.k", downloads: { $sum: "$pairs.v" } } },
      ]),
    ]);

    function toCountMap(rows: unknown[]): Map<string, number> {
      const m = new Map<string, number>();
      if (!Array.isArray(rows)) return m;
      for (const r of rows) {
        const row = r as any;
        const k = typeof row?._id === "string" ? row._id : "";
        const v = typeof row?.count === "number" ? row.count : typeof row?.downloads === "number" ? row.downloads : null;
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
    return NextResponse.json({
      ok: true,
      generatedAt: now.toISOString(),
      window: {
        days7Start: since7d.toISOString(),
        days30Start: since30d.toISOString(),
      },
      series30d,
      docs: {
        active: docsActive,
        created30d: docsCreated30d,
      },
      projects: {
        active: projectsActive,
        requests: requestsActive,
      },
      uploads: {
        created30d: uploads30d,
      },
      sharing: {
        viewsTotal: typeof shareRow?.viewsTotal === "number" ? shareRow.viewsTotal : 0,
        pagesViewedTotal: typeof shareRow?.pagesViewedTotal === "number" ? shareRow.pagesViewedTotal : 0,
        views30d: typeof shareRow?.views30d === "number" ? shareRow.views30d : 0,
        pagesViewed30d: typeof shareRow?.pagesViewed30d === "number" ? shareRow.pagesViewed30d : 0,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


