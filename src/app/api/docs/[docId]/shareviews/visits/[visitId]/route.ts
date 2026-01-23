/**
 * Owner doc share-view visit details API.
 * Route: `/api/docs/:docId/shareviews/visits/:visitId`
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ docId: string; visitId: string }> }) {
  const actor = await resolveActor(request);
  try {
    const { docId, visitId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }
    if (!Types.ObjectId.isValid(visitId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid visitId" }, { status: 400 }), actor);
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

    const visit = await ShareVisitModel.findOne({ _id: new Types.ObjectId(visitId), docId: docObjectId })
      .select({
        _id: 1,
        shareId: 1,
        startedAt: 1,
        lastEventAt: 1,
        timeSpentMs: 1,
        pagesSeen: 1,
        pageTimeMsByPage: 1,
        pageVisitCountByPage: 1,
        pageEvents: 1,
      })
      .lean();

    if (!visit) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const eventsRaw = Array.isArray((visit as any).pageEvents) ? ((visit as any).pageEvents as any[]) : [];
    const events = eventsRaw
      .map((e) => ({
        pageNumber: typeof e?.pageNumber === "number" && Number.isFinite(e.pageNumber) ? Math.floor(e.pageNumber) : null,
        enteredAt: e?.enteredAt ? new Date(e.enteredAt).toISOString() : null,
        leftAt: e?.leftAt ? new Date(e.leftAt).toISOString() : null,
        durationMs: typeof e?.durationMs === "number" && Number.isFinite(e.durationMs) ? Math.max(0, Math.floor(e.durationMs)) : 0,
      }))
      .filter((e) => Boolean(e.pageNumber && e.pageNumber >= 1));

    const pagesSeen = Array.isArray((visit as any).pagesSeen) ? ((visit as any).pagesSeen as unknown[]) : [];
    const pagesSeenNumbers = pagesSeen
      .map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : null))
      .filter((n): n is number => Boolean(n && n >= 1))
      .sort((a, b) => a - b);

    const pageTimeMsByPage =
      (visit as any).pageTimeMsByPage && typeof (visit as any).pageTimeMsByPage === "object" ? (visit as any).pageTimeMsByPage : {};
    const pageVisitCountByPage =
      (visit as any).pageVisitCountByPage && typeof (visit as any).pageVisitCountByPage === "object"
        ? (visit as any).pageVisitCountByPage
        : {};

    const revisitedPages = pagesSeenNumbers.filter((p) => {
      const c = (pageVisitCountByPage as any)?.[String(p)];
      return typeof c === "number" && Number.isFinite(c) && c >= 2;
    });

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          docId,
          visit: {
            visitId: String((visit as any)._id),
            shareId: typeof (visit as any).shareId === "string" ? (visit as any).shareId : null,
            startedAt: (visit as any).startedAt ? new Date((visit as any).startedAt).toISOString() : null,
            lastEventAt: (visit as any).lastEventAt ? new Date((visit as any).lastEventAt).toISOString() : null,
            timeSpentMs:
              typeof (visit as any).timeSpentMs === "number" && Number.isFinite((visit as any).timeSpentMs)
                ? Math.max(0, Math.floor((visit as any).timeSpentMs))
                : 0,
            pagesSeen: pagesSeenNumbers,
            revisitedPages,
            pageTimeMsByPage,
            pageVisitCountByPage,
            events,
          },
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

