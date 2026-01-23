/**
 * Owner doc share-view visits API (per-visit breakdown for a viewer).
 * Route: `/api/docs/:docId/shareviews/visits`
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const actor = await resolveActor(request);
  try {
    const url = new URL(request.url);
    const { docId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }

    const kindRaw = url.searchParams.get("kind");
    const kind = kindRaw === "authed" || kindRaw === "anon" ? kindRaw : null;
    if (!kind) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing kind" }, { status: 400 }), actor);
    }

    const userId = url.searchParams.get("userId");
    const botIdHash = url.searchParams.get("botIdHash");
    if (kind === "authed" && (!userId || !Types.ObjectId.isValid(userId))) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }
    if (kind === "anon" && (!botIdHash || typeof botIdHash !== "string" || botIdHash.trim().length < 16)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid botIdHash" }, { status: 400 }), actor);
    }

    const limit = Math.min(200, asPositiveInt(url.searchParams.get("limit")) ?? 50);

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

    const query: Record<string, unknown> = { docId: docObjectId };
    if (kind === "authed") query.viewerUserId = new Types.ObjectId(userId!);
    if (kind === "anon") query.botIdHash = botIdHash!.trim();

    const visits = await ShareVisitModel.find(query)
      .sort({ lastEventAt: -1 })
      .limit(limit)
      .select({
        _id: 1,
        startedAt: 1,
        lastEventAt: 1,
        timeSpentMs: 1,
        pagesSeen: 1,
        pageTimeMsByPage: 1,
        pageVisitCountByPage: 1,
      })
      .lean();

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          docId,
          kind,
          visits: visits.map((v: any) => ({
            visitId: String(v._id),
            startedAt: v.startedAt ? new Date(v.startedAt).toISOString() : null,
            lastEventAt: v.lastEventAt ? new Date(v.lastEventAt).toISOString() : null,
            timeSpentMs: typeof v.timeSpentMs === "number" && Number.isFinite(v.timeSpentMs) ? Math.max(0, Math.floor(v.timeSpentMs)) : 0,
            pagesSeen: Array.isArray(v.pagesSeen) ? v.pagesSeen : [],
            pageTimeMsByPage: v.pageTimeMsByPage && typeof v.pageTimeMsByPage === "object" ? v.pageTimeMsByPage : {},
            pageVisitCountByPage: v.pageVisitCountByPage && typeof v.pageVisitCountByPage === "object" ? v.pageVisitCountByPage : {},
          })),
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}

