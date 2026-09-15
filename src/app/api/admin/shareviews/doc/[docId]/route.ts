/**
 * Admin API route: `/api/admin/shareviews/doc/:docId`
 *
 * Returns all per-viewer ShareView records for a specific document.
 * Used by the admin Share Views dashboard.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ShareViewModel } from "@/lib/models/ShareView";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";
/**
 * Handle GET requests.
 */


/**
 *
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  return withMongoRequestLogging(request, async () => {
    const auth = await requireAdmin(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { docId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    await connectMongo();

    const items = await ShareViewModel.aggregate([
      { $match: { docId: new Types.ObjectId(docId) } },
      { $sort: { updatedDate: -1 } },
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
          shareId: 1,
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
            shareId: "$doc.shareId",
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


