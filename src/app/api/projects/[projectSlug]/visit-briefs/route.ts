/**
 * `GET /api/projects/:projectId/visit-briefs` — finished sittings on this data room's links, newest
 * first, each with its stored visit brief or the reason it got a recap instead. The project twin of
 * `/api/docs/:docId/visit-briefs`: a project-link sitting is one row for the whole room, listing
 * the documents opened, and it belongs to the project rather than to any one document.
 *
 * `?kind=anon&botIdHash=` or `?kind=authed&userId=` narrows to one reader (the reader page);
 * `?shareId=` to one link. Pro only (`402 UPGRADE_REQUIRED`), like the room's session timeline.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { analyticsTierForPlan, getWorkspacePlan } from "@/lib/billing/planLimits";
import { PROJECT_LINK_FILTER, ShareLinkModel } from "@/lib/models/ShareLink";
import { accessProjectForLinks } from "../links/shared";
import { listVisitBriefs } from "@/lib/visits/visitBriefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *
 */
export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "viewer");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId } = gate.access;

  try {
    const url = new URL(request.url);
    const kindRaw = url.searchParams.get("kind");
    const kind = kindRaw === "authed" || kindRaw === "anon" ? kindRaw : null;
    const userId = (url.searchParams.get("userId") ?? "").trim();
    const botIdHash = (url.searchParams.get("botIdHash") ?? "").trim();
    const shareIdFilter = (url.searchParams.get("shareId") ?? "").trim();
    const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 50) || 50)));

    if (kind === "authed" && !Types.ObjectId.isValid(userId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid userId" }, { status: 400 }), actor);
    }
    if (kind === "anon" && botIdHash.length < 16) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid botIdHash" }, { status: 400 }), actor);
    }

    await connectMongo();

    const plan = await getWorkspacePlan(String(orgId));
    if (analyticsTierForPlan(plan) !== "deep") {
      return applyTempUserHeaders(NextResponse.json({ error: "UPGRADE_REQUIRED" }, { status: 402 }), actor);
    }

    if (shareIdFilter) {
      const link = await ShareLinkModel.exists({ shareId: shareIdFilter, projectId, ...PROJECT_LINK_FILTER });
      if (!link) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const visits = await listVisitBriefs({
      orgId: new Types.ObjectId(String(orgId)),
      projectId: new Types.ObjectId(String(projectId)),
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
