/**
 * One share link — `PATCH`/`DELETE /api/docs/:docId/links/:linkId`
 * (docs/prds/lnkdrp-multi-links.md).
 *
 * PATCH changes a link's settings (enabling a disabled link re-checks the Free cap; at the cap
 * nothing changes and the response carries `planWarning`). DELETE soft-archives the link: it stops
 * resolving, its analytics stay attached to its `shareId`, and the default link refuses to be
 * archived (400) because disabling it is the intended action.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { archiveShareLink, listShareLinks, toShareLinkDTO, updateShareLink, ShareLinkError } from "@/lib/share/links";
import { accessDocForLinks, linkErrorResponse, planWarningOf } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Throw `not_found` unless the link belongs to the document in the path.
 *
 * The service scopes links by workspace, so without this a member could patch another document's
 * link through any `docId` they can reach.
 */
async function assertLinkOnDoc(orgId: Types.ObjectId, docId: Types.ObjectId, linkId: string): Promise<void> {
  const links = await listShareLinks({ orgId, docId, includeArchived: true });
  if (!links.some((l) => String(l._id) === linkId)) throw new ShareLinkError("not_found", "Link not found.");
}

/** Settings a PATCH may carry; anything absent is left untouched. */
type LinkPatch = Partial<{
  label: string;
  audience: string | null;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  expiresAt: string | null;
  password: string | null;
}>;

/**
 * `PATCH /api/docs/:docId/links/:linkId`
 *
 * In: any subset of `{ label, audience, enabled, allowDownload, allowRevisionHistory, expiresAt,
 * password }` (`password: null` clears it). Out: `{ link, planWarning? }`. A `planWarning` with a
 * `message` means the cap refused the change and the link is unchanged.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ docId: string; linkId: string }> }) {
  const { docId, linkId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "member");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId, title } = gate.access;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }
    const body = (await request.json().catch(() => ({}))) as LinkPatch;
    const settings: LinkPatch = {};
    if (typeof body.label === "string") settings.label = body.label;
    if (body.audience !== undefined) settings.audience = body.audience;
    if (typeof body.enabled === "boolean") settings.enabled = body.enabled;
    if (typeof body.allowDownload === "boolean") settings.allowDownload = body.allowDownload;
    if (typeof body.allowRevisionHistory === "boolean") settings.allowRevisionHistory = body.allowRevisionHistory;
    if (body.expiresAt !== undefined) settings.expiresAt = body.expiresAt;
    if (body.password !== undefined) settings.password = body.password;
    if (Object.keys(settings).length === 0) {
      return applyTempUserHeaders(NextResponse.json({ error: "No settings to update." }, { status: 400 }), actor);
    }

    await assertLinkOnDoc(orgId, docObjectId, linkId);
    const { link, limit } = await updateShareLink({ orgId, linkId, settings });

    const dto = toShareLinkDTO(link);
    const blocked = Boolean(limit && !limit.ok);
    if (!blocked) {
      void recordActivity({
        orgId: String(orgId),
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share_link.updated",
        docId: docObjectId,
        title,
        meta: { linkId: dto.id, shareId: dto.shareId, linkLabel: dto.label, changed: Object.keys(settings), enabled: dto.enabled },
        request,
      });
    }

    const planWarning = planWarningOf(limit);
    return applyTempUserHeaders(
      NextResponse.json({ link: dto, ...(planWarning ? { planWarning } : {}) }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}

/**
 * `DELETE /api/docs/:docId/links/:linkId`
 *
 * Soft-archives the link and returns `204`. The default link cannot be archived: that is a `400`
 * (`code: "validation"`), and the caller should disable it instead.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ docId: string; linkId: string }> }) {
  const { docId, linkId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "member");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId, title } = gate.access;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }
    await assertLinkOnDoc(orgId, docObjectId, linkId);
    const link = await archiveShareLink({ orgId, linkId });

    void recordActivity({
      orgId: String(orgId),
      userId: actor.userId,
      actorKind: actor.kind,
      type: "share_link.revoked",
      docId: docObjectId,
      title,
      meta: { linkId: String(link._id), shareId: link.shareId, linkLabel: link.label },
      request,
    });

    return applyTempUserHeaders(new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } }), actor);
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
