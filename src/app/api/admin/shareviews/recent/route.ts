/**
 * Admin API route: `/api/admin/shareviews/recent`
 *
 * Returns the most recent per-viewer ShareView records across all docs.
 * Used by the admin Share Views dashboard.
 */
import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { ShareViewModel } from "@/lib/models/ShareView";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";
/**
 * As Positive Int (uses Number, isFinite, floor).
 */


/**
 *
 */
function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}
/**
 * Handle GET requests.
 */


/**
 *
 */
export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const auth = await requireAdmin(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const url = new URL(request.url);
    const limit = asPositiveInt(url.searchParams.get("limit")) ?? 200;

    await connectMongo();

    const items = await ShareViewModel.aggregate([
      { $sort: { updatedDate: -1 } },
      { $limit: Math.min(limit, 500) },
      {
        $lookup: {
          from: "docs",
          localField: "docId",
          foreignField: "_id",
          as: "doc",
        },
      },
      { $unwind: { path: "$doc", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "users",
          localField: "viewerUserId",
          foreignField: "_id",
          as: "viewerUser",
        },
      },
      { $unwind: { path: "$viewerUser", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          // The link slug is not projected: `/s/:shareId` renders the customer's document, so a
          // slug beside the view it produced would let staff open the thing they are auditing
          // views of — and the visit would land in the owner's analytics as an anonymous
          // recipient. The doc id below is what identifies the row.
          pagesSeen: 1,
          downloads: 1,
          downloadsByDay: 1,
          createdDate: 1,
          updatedDate: 1,
          viewerEmail: 1,
          viewerIp: 1,
          docId: {
            _id: "$doc._id",
            title: "$doc.title",
          },
          viewerUserId: {
            _id: "$viewerUser._id",
            email: "$viewerUser.email",
            name: "$viewerUser.name",
          },
        },
      },
    ]);

    return NextResponse.json({ ok: true, items });
  });
}


