/**
 * API route for `/api/docs/:docId/history/:version/viewer/:userId`.
 *
 * Returns per-page timing aggregates for a given viewer on a specific doc version.
 * Auth required; any org member with access to the doc can call this.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, applyTempUserHeaders } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string; version: string; userId: string }> },
) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    const { docId, version: versionRaw, userId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }
    if (!Types.ObjectId.isValid(userId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }
    const version = asPositiveInt(versionRaw);
    if (!version) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid version" }, { status: 400 }), actor);
    }

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
    if (!docExists) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const viewerUserId = new Types.ObjectId(userId);
    const viewer = await UserModel.findById(viewerUserId).select({ _id: 1, name: 1, email: 1 }).lean();

    const agg = (await DocPageTimingModel.aggregate([
      { $match: { orgId, docId: docObjectId, version, viewerUserId } },
      {
        $group: {
          _id: "$pageNumber",
          durationMs: { $sum: "$durationMs" },
          firstSeen: { $min: "$enteredAt" },
          lastSeen: { $max: "$leftAt" },
        },
      },
      { $sort: { _id: 1 } },
    ])) as Array<{ _id: number; durationMs: number; firstSeen?: Date; lastSeen?: Date }>;

    const pages = agg.map((p) => ({
      pageNumber: typeof p._id === "number" ? p._id : null,
      durationMs: typeof p.durationMs === "number" && Number.isFinite(p.durationMs) ? p.durationMs : 0,
      firstSeen: p.firstSeen ? new Date(p.firstSeen).toISOString() : null,
      lastSeen: p.lastSeen ? new Date(p.lastSeen).toISOString() : null,
    }));
    const totalDurationMs = pages.reduce((s, p) => s + (p.durationMs ?? 0), 0);
    const viewedPage1 = pages.some((p) => p.pageNumber === 1);

    return applyTempUserHeaders(
      NextResponse.json({
        ok: true,
        docId,
        version,
        viewer: viewer
          ? {
              userId: String(viewer._id),
              name: typeof (viewer as any).name === "string" ? (viewer as any).name : null,
              email: typeof (viewer as any).email === "string" ? (viewer as any).email : null,
            }
          : null,
        viewedPage1,
        totalDurationMs,
        pages,
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}


