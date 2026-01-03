/**
 * API route for `/api/docs/:docId/changes`.
 *
 * Returns replacement history (what changed) for a doc. Only available to users
 * who have access to the doc (same access rules as other `/api/docs/:docId/*` routes).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { DocChangeModel } from "@/lib/models/DocChange";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  try {
    const { docId } = await ctx.params;
    if (!isObjectId(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

    const actor = await resolveActor(request);
    await connectMongo();

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback).
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docExists = await DocModel.exists({
      ...(allowLegacyByUserId
        ? {
            $or: [
              { _id: docObjectId, orgId, isDeleted: { $ne: true } },
              {
                _id: docObjectId,
                userId: legacyUserId,
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: docObjectId, orgId, isDeleted: { $ne: true } }),
    });
    if (!docExists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const changesAgg = (await DocChangeModel.aggregate([
      {
        $match: {
          docId: docObjectId,
          ...(allowLegacyByUserId ? {} : { orgId }),
        },
      },
      { $sort: { toVersion: -1, createdDate: -1 } },
      { $limit: 50 },
      {
        $lookup: {
          from: "users",
          localField: "createdByUserId",
          foreignField: "_id",
          as: "createdByUser",
        },
      },
      { $unwind: { path: "$createdByUser", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          docId: 1,
          fromUploadId: 1,
          toUploadId: 1,
          fromVersion: 1,
          toVersion: 1,
          diff: 1,
          previousText: 1,
          newText: 1,
          createdDate: 1,
          createdByUserId: 1,
          createdByUser: { _id: 1, name: 1, email: 1, isTemp: 1 },
        },
      },
    ])) as Array<Record<string, any>>;

    return applyTempUserHeaders(
      NextResponse.json({
        docId,
        changes: changesAgg.map((c) => ({
          id: String(c._id),
          docId: c.docId ? String(c.docId) : docId,
          fromUploadId: c.fromUploadId ? String(c.fromUploadId) : null,
          toUploadId: c.toUploadId ? String(c.toUploadId) : null,
          fromVersion: typeof c.fromVersion === "number" && Number.isFinite(c.fromVersion) ? c.fromVersion : null,
          toVersion: typeof c.toVersion === "number" && Number.isFinite(c.toVersion) ? c.toVersion : null,
          summary: c?.diff?.summary ?? "",
          changes: Array.isArray(c?.diff?.changes) ? c.diff.changes : [],
          previousText: typeof c.previousText === "string" ? c.previousText : "",
          newText: typeof c.newText === "string" ? c.newText : "",
          createdBy: (function () {
            const u = c.createdByUser;
            if (!u || typeof u !== "object") return null;
            const id = u._id ? String(u._id) : null;
            const name = typeof u.name === "string" && u.name.trim() ? u.name.trim() : null;
            const email = typeof u.email === "string" && u.email.trim() ? u.email.trim() : null;
            return { id, name, email };
          })(),
          createdDate: c.createdDate ? new Date(c.createdDate).toISOString() : null,
        })),
      }),
      actor,
    );
  } catch (err) {
    const actor = await resolveActor(request).catch(() => null);
    const message = err instanceof Error ? err.message : "Unknown error";
    const res = NextResponse.json({ error: message }, { status: 400 });
    return actor ? applyTempUserHeaders(res, actor) : res;
  }
}


