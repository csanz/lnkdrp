/**
 * Admin API route: `/api/admin/shareviews/doc/:docId`
 *
 * Per-viewer ShareView records for one document, newest activity first, one page at a time.
 * Used by the admin Share Views dashboard.
 *
 * Query: `limit` (1-500, default 100) and `cursor` (the previous page's `nextCursor`). It used to
 * return every row of the document in one response with no bound at all (code review 2026-09-23,
 * M13); a well-read document is thousands of rows, each carrying two lookups.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ShareViewModel } from "@/lib/models/ShareView";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { dateIdCursorClause, decodeDateIdCursor, encodeDateIdCursor, parseLimit } from "@/lib/http/dateIdCursor";

export const runtime = "nodejs";

/** Rows per page when the caller does not say. */
const DEFAULT_LIMIT = 100;
/** The most rows one page may carry. */
const MAX_LIMIT = 500;

/** One page of a document's share views. */
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

    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const cursor = decodeDateIdCursor(url.searchParams.get("cursor"));
    const match: Record<string, unknown> = cursor
      ? { $and: [{ docId: new Types.ObjectId(docId) }, dateIdCursorClause("updatedDate", cursor)] }
      : { docId: new Types.ObjectId(docId) };

    const rows = (await ShareViewModel.aggregate([
      { $match: match },
      { $sort: { updatedDate: -1, _id: -1 } },
      // One extra row says whether there is a next page, without a count.
      { $limit: limit + 1 },
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
          _id: 1,
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
    ])) as Array<{ _id: Types.ObjectId; updatedDate?: Date }>;

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last?.updatedDate instanceof Date ? encodeDateIdCursor({ date: last.updatedDate, id: last._id }) : null;

    return NextResponse.json({ ok: true, items, nextCursor, limit });
  });
}


