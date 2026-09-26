/**
 * Shared access check for owner analytics routes on one document: who is asking, whether the
 * document is theirs, and which analytics tier and history limit its workspace plan allows.
 *
 * Same rules as `GET /api/docs/:docId/shareviews`: the document must belong to the actor's active
 * workspace (or, in a personal workspace, be a legacy org-less document the actor created), and a
 * deleted document is a 404. The plan comes from the document's own workspace, not the actor's.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFast, type Actor } from "@/lib/gating/actor";
import {
  analyticsTierForPlan,
  getWorkspacePlan,
  limitsForPlan,
  type AnalyticsTier,
  type PlanId,
} from "@/lib/billing/planLimits";

export type DocAnalyticsDoc = {
  _id: Types.ObjectId;
  orgId: Types.ObjectId | null;
  title: string;
  slideNodes: Array<{ pageNumber: number; thumbUrl: string | null }>;
  pageSlugs: Array<{ pageNumber: number; slug: string }>;
};

export type DocAnalyticsAccess =
  | { ok: true; actor: Actor; doc: DocAnalyticsDoc; plan: PlanId; tier: AnalyticsTier; daysLimit: number | null }
  | { ok: false; response: Response };

/** Resolve the actor, load the document they own and derive the plan tier, or return the error response. */
export async function resolveDocAnalyticsAccess(request: Request, docId: string): Promise<DocAnalyticsAccess> {
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  const fail = (status: number, error: string): DocAnalyticsAccess => ({
    ok: false,
    response: applyTempUserHeaders(
      NextResponse.json({ error }, { status, headers: { "cache-control": "private, no-store" } }),
      actor,
    ),
  });

  if (!Types.ObjectId.isValid(docId)) return fail(400, "Invalid docId");

  await connectMongo();
  const docObjectId = new Types.ObjectId(docId);
  const orgId = new Types.ObjectId(actor.orgId);
  const legacyUserId = new Types.ObjectId(actor.userId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  const lockedExclusion = await lockedHomeExclusionFor(orgId, actor.userId, request);
  const raw = await DocModel.findOne(buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId, lockedExclusion))
    .select({ _id: 1, orgId: 1, title: 1, slideNodes: 1, pageSlugs: 1 })
    .lean<{ _id: Types.ObjectId; orgId?: Types.ObjectId | null; title?: unknown; slideNodes?: unknown; pageSlugs?: unknown }>();
  if (!raw) return fail(404, "Not found");

  const slideNodes = (Array.isArray(raw.slideNodes) ? raw.slideNodes : [])
    .map((n) => n as { pageNumber?: unknown; thumbUrl?: unknown })
    .map((n) => ({
      pageNumber: typeof n?.pageNumber === "number" ? n.pageNumber : 0,
      thumbUrl: typeof n?.thumbUrl === "string" && n.thumbUrl ? n.thumbUrl : null,
    }));
  const pageSlugs = (Array.isArray(raw.pageSlugs) ? raw.pageSlugs : [])
    .map((s) => s as { pageNumber?: unknown; slug?: unknown })
    .filter((s) => typeof s?.pageNumber === "number" && typeof s.slug === "string")
    .map((s) => ({ pageNumber: s.pageNumber as number, slug: s.slug as string }));

  const plan = await getWorkspacePlan(raw.orgId ? String(raw.orgId) : actor.orgId);
  return {
    ok: true,
    actor,
    doc: {
      _id: raw._id,
      orgId: raw.orgId ?? null,
      title: typeof raw.title === "string" ? raw.title.trim() : "",
      slideNodes,
      pageSlugs,
    },
    plan,
    tier: analyticsTierForPlan(plan),
    daysLimit: limitsForPlan(plan).analyticsDays,
  };
}
