/**
 * `GET /api/docs/:docId/visit-briefs` — finished sittings on this document's own links, newest
 * first, each with its stored visit brief or the reason it got a recap instead
 * (docs/prds/lnkdrp-visit-briefs.md, "Surfaces").
 *
 * Two readers: the reader page asks for one person (`?kind=anon&botIdHash=` or
 * `?kind=authed&userId=`), and the MCP asks for the document (`lnkdrp_get_share_stats
 * { includeVisits }`), optionally one link (`?shareId=`). Skipped visits — owner previews, glances,
 * Free-plan sittings — have no card and are not listed.
 *
 * Pro only, like the session timeline beside it: a brief narrates per-page reading that Free does
 * not show, and rows written while a workspace was Pro must not leak after a downgrade. Free gets
 * `402 plan_limit` (`analytics_history`), after ownership so foreign documents stay 404.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { listVisitBriefs } from "@/lib/visits/visitBriefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *
 */
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
    const userId = (url.searchParams.get("userId") ?? "").trim();
    const botIdHash = (url.searchParams.get("botIdHash") ?? "").trim();
    if (kind === "authed" && !Types.ObjectId.isValid(userId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }
    if (kind === "anon" && botIdHash.length < 16) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid botIdHash" }, { status: 400 }), actor);
    }
    const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 50) || 50)));

    await connectMongo();

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback).
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docExists = await DocModel.exists(buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId));
    if (!docExists) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const gate = await checkLimit(actor.orgId, "analytics_history");
    if (!gate.ok) return applyTempUserHeaders(planLimitResponse(gate, { orgId: actor.orgId, userId: actor.userId, actorKind: actor.kind, docId: docObjectId, request }), actor);

    // Per-link scope. An unknown slug is a 404, like the metrics route — never a silent whole-doc read.
    const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
    if (shareIdFilter) {
      const link = await ShareLinkModel.exists({ shareId: shareIdFilter, docId: docObjectId });
      if (!link) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const visits = await listVisitBriefs({
      orgId,
      docId: docObjectId,
      shareId: shareIdFilter || null,
      viewerUserId: kind === "authed" ? new Types.ObjectId(userId) : null,
      botIdHash: kind === "anon" ? botIdHash : null,
      limit,
    });
    return applyTempUserHeaders(NextResponse.json({ visits }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 500 }), actor);
  }
}
