/**
 * Admin API route: `/api/admin/shareviews/doc/:docId`
 *
 * Returns all per-viewer ShareView records for a specific document.
 * Used by the admin Share Views dashboard.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { ShareViewModel } from "@/lib/models/ShareView";
import { UserModel } from "@/lib/models/User";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
/**
 * Return whether localhost request.
 */


function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}
/**
 * Require Admin (uses isLocalhostRequest, resolveActor, isValid).
 */


async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}
/**
 * Handle GET requests.
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


