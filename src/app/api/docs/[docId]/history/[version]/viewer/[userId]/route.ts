/**
 * API route for `/api/docs/:docId/history/:version/viewer/:userId`.
 *
 * Returns per-page timing aggregates for a given viewer on a specific doc version.
 * Auth required; any org member with access to the doc can call this.
 *
 * It answers with timings only. The viewer's name and email belong to the recipients list
 * (`../recipients`), which is built from this org's memberships — see the note by the aggregate.
 *
 * Deep analytics: per-viewer, per-page time is Pro-only. Free workspaces get `402 plan_limit`
 * (`analytics_history`).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, applyTempUserHeaders } from "@/lib/gating/actor";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { DocModel } from "@/lib/models/Doc";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";

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

    // Per-viewer page time is deep analytics (Pro). Checked after ownership so foreign docs stay 404.
    const gate = await checkLimit(actor.orgId, "analytics_history");
    if (!gate.ok) return applyTempUserHeaders(planLimitResponse(gate, { orgId: actor.orgId, userId: actor.userId, actorKind: actor.kind, docId: docObjectId, request }), actor);

    /**
     * `:userId` is a lookup key for this document's timing rows, never a key into `users`.
     *
     * This route used to answer with the name and email behind the id, read straight from
     * `UserModel.findById(userId)` with no org, membership or "did this person ever open this
     * document" constraint. The ownership check above only proves the *document* is the caller's,
     * so any signed-in owner of any document could ask their own doc about a stranger's id and be
     * told who it belonged to — and Mongo ObjectIds are a timestamp plus a per-process counter, so
     * one known id walks to its neighbours and the whole `users` collection comes out a name at a
     * time, across every tenant.
     *
     * The identity was never this route's to serve: the drill-down is opened from the recipients
     * list, which is built from *this org's* memberships (`../recipients/route.ts`), and the modal
     * renders the name it already has from that row. So the answer is to stop looking the user up
     * rather than to fence the lookup — there is no fence left to get wrong. The aggregate below
     * is bounded by `orgId`, which makes an unrelated id an empty `pages: []` and nothing else.
     */
    const viewerUserId = new Types.ObjectId(userId);

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


