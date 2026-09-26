/**
 * Shared plumbing for the share-link routes (`/api/docs/:docId/links[/:linkId]`).
 *
 * Colocated with the routes (not a route file itself, so Next ignores it). It carries the two
 * things both handlers need and nothing else: the actor + membership check with the same legacy
 * personal-doc fallback `/api/docs/:docId` uses, and the `planWarning` shape the doc routes
 * already return so the web client can reuse `parsePlanLimitError` / the upgrade modal.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";
import { requireOrgRole, type OrgRole } from "@/lib/orgs/requireOrgRole";
import { ShareLinkError } from "@/lib/share/links";
import type { LimitCheck } from "@/lib/billing/planLimits";

/** `planWarning` body field: the Free-cap state the UI needs to render an upsell. */
export type PlanWarning = {
  limit: string;
  used: number;
  max: number;
  grace: unknown;
  /** Present only when the cap actually blocked the change (the link stays disabled). */
  message?: string;
  upgradeUrl?: string;
};

/**
 * Turn a `checkLimit()` result into the optional `planWarning` body field.
 *
 * Inside the grace window `limit.ok` is true with a warning; at the cap the service still creates
 * (or leaves) the link disabled and reports `ok: false`, which the caller surfaces as a warning
 * rather than a 402 so the link is never silently lost.
 */
export function planWarningOf(limit: LimitCheck | null | undefined): PlanWarning | undefined {
  if (!limit) return undefined;
  if (limit.ok) {
    return limit.warning
      ? { limit: limit.warning.limit, used: limit.warning.used, max: limit.warning.max, grace: limit.warning.grace }
      : undefined;
  }
  return {
    limit: limit.limit,
    used: limit.used,
    max: limit.max,
    grace: limit.grace,
    message: limit.message,
    upgradeUrl: limit.upgradeUrl,
  };
}

export type DocAccess = {
  actor: Actor;
  docId: Types.ObjectId;
  /** The workspace the document belongs to (backfilled for legacy personal docs). */
  orgId: Types.ObjectId;
  title: string | null;
  /**
   * The document's home project as a string, or null when it lives in no project
   * (docs/prds/lnkdrp-project-home.md, decision 2).
   *
   * It is read here, off the row both handlers already fetch, because every link event belongs to
   * the room the document lives in as much as to the workspace: a project's own feed is filtered on
   * the row's `projectId` (`GET /api/activity?projectId=`), so a row without it is simply missing
   * from the room whose document it describes.
   */
  homeProjectId: string | null;
};

export type DocAccessResult = { ok: true; access: DocAccess } | { ok: false; response: Response };

/**
 * Resolve the caller and the document they addressed, enforcing `minRole` in the workspace.
 *
 * Mirrors `/api/docs/:docId`: org-scoped lookup with a fallback to legacy personal docs that have
 * no `orgId` yet (those are backfilled here, as the doc GET does, so the link service — which is
 * strictly org-scoped — can find them).
 */
export async function accessDocForLinks(
  request: Request,
  docIdRaw: string,
  minRole: OrgRole,
): Promise<DocAccessResult> {
  const actor = await resolveActor(request);
  if (!Types.ObjectId.isValid(docIdRaw)) {
    return { ok: false, response: applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor) };
  }
  const roleCheck = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole });
  if (!roleCheck.ok) {
    return { ok: false, response: applyTempUserHeaders(NextResponse.json({ error: roleCheck.error }, { status: roleCheck.status }), actor) };
  }

  await connectMongo();
  const docId = new Types.ObjectId(docIdRaw);
  const orgId = new Types.ObjectId(actor.orgId);
  const legacyUserId = new Types.ObjectId(actor.userId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  const lockedExclusion = await lockedHomeExclusionFor(orgId, actor.userId, request);
  const doc = (await DocModel.findOne(buildDocMatch(docId, orgId, legacyUserId, allowLegacyByUserId, lockedExclusion))
    .select({ _id: 1, orgId: 1, title: 1, primaryProjectId: 1 })
    .lean()) as
    | { _id: Types.ObjectId; orgId?: Types.ObjectId | null; title?: string | null; primaryProjectId?: Types.ObjectId | null }
    | null;
  if (!doc) {
    return { ok: false, response: applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor) };
  }

  // Legacy personal doc with no workspace yet: adopt it into the actor's org so the link service
  // (which always scopes by orgId) can see it. Best-effort, exactly like the doc GET does.
  if (!doc.orgId) {
    try {
      await DocModel.updateOne({ _id: docId }, { $set: { orgId } });
      doc.orgId = orgId;
    } catch {
      // ignore; best-effort
    }
  }

  return {
    ok: true,
    access: {
      actor,
      docId,
      orgId: doc.orgId ?? orgId,
      title: typeof doc.title === "string" ? doc.title : null,
      homeProjectId: doc.primaryProjectId ? String(doc.primaryProjectId) : null,
    },
  };
}

/** Map a `ShareLinkError` (or anything unexpected) to the JSON error body the routes return. */
export function linkErrorResponse(err: unknown, actor: Actor): Response {
  if (err instanceof ShareLinkError) {
    return applyTempUserHeaders(NextResponse.json({ error: err.message, code: err.code }, { status: err.status }), actor);
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
}
