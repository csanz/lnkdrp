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
import {
  archiveShareLink,
  listShareLinks,
  setDefaultShareLink,
  shareLinkStatsByShareId,
  toShareLinkDTO,
  updateShareLink,
  ShareLinkError,
} from "@/lib/share/links";
import { planLimitResponse } from "@/lib/billing/planLimits";
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
  /** `true` promotes this link to the document's default. */
  isDefault: boolean;
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
    // `isDefault: true` promotes this link (it is not a settings field; `isDefault: false` is a
    // no-op — promote another link instead, so a document always has exactly one default).
    const makeDefault = body.isDefault === true;
    if (Object.keys(settings).length === 0 && !makeDefault) {
      return applyTempUserHeaders(NextResponse.json({ error: "No settings to update." }, { status: 400 }), actor);
    }

    await assertLinkOnDoc(orgId, docObjectId, linkId);
    if (makeDefault) await setDefaultShareLink({ orgId, docId: docObjectId, linkId });
    const { link, limit, restored } =
      Object.keys(settings).length > 0
        ? await updateShareLink({ orgId, linkId, settings })
        : {
            link: (await listShareLinks({ orgId, docId: docObjectId })).find((l) => String(l._id) === String(linkId))!,
            limit: null,
            restored: undefined,
          };

    // Recomputed from the rows, like every other surface: returning the stored counters here made
    // an agent's `update_share_link` reply disagree with the `list_share_links` it had just read.
    const dto = toShareLinkDTO(link, (await shareLinkStatsByShareId(docObjectId)).get(link.shareId) ?? null);
    const blocked = Boolean(limit && !limit.ok);
    if (!blocked) {
      void recordActivity({
        orgId: String(orgId),
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share_link.updated",
        docId: docObjectId,
        title,
        meta: {
          linkId: dto.id,
          shareId: dto.shareId,
          linkLabel: dto.label,
          changed: Object.keys(settings),
          enabled: dto.enabled,
          // New values for the feed's wording. The password is reduced to set/cleared; the secret is never logged.
          values: {
            ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
            ...(settings.allowDownload !== undefined ? { allowDownload: settings.allowDownload } : {}),
            ...(settings.allowRevisionHistory !== undefined ? { allowRevisionHistory: settings.allowRevisionHistory } : {}),
            ...(settings.label !== undefined ? { label: dto.label } : {}),
            ...(settings.expiresAt !== undefined ? { expires: settings.expiresAt ? "set" : "cleared" } : {}),
            ...(settings.password !== undefined ? { password: settings.password ? "set" : "cleared" } : {}),
            ...(makeDefault ? { isDefault: true } : {}),
          },
        },
        request,
      });
    }

    // A refused version_history change is a hard no: nothing was written, so answer 402 with the
    // standard plan_limit body like the document-level PATCH, rather than a 200 that looks applied.
    // The active-links cap stays a 200 + planWarning, because there the link is still created.
    if (blocked && limit && !limit.ok && limit.limit === "version_history") {
      return applyTempUserHeaders(planLimitResponse(limit), actor);
    }

    const planWarning = planWarningOf(limit);
    return applyTempUserHeaders(
      NextResponse.json(
        {
          link: dto,
          ...(planWarning ? { planWarning } : {}),
          // Enabling a link can re-share the document and bring back the links its switch had taken
          // down. That changes who can reach the document, so it is reported rather than left for
          // the caller to notice by listing.
          ...(restored?.length
            ? {
                warnings: [
                  `Turning this link on re-shared the document, which also restored ${restored.length} link(s) that were ` +
                    `disabled when sharing was switched off: ${restored
                      .map((l) => (typeof l.label === "string" && l.label.trim() ? l.label.trim() : l.shareId))
                      .join(", ")}. Links revoked individually were not restored.`,
                ],
              }
            : {}),
        },
        { headers: { "cache-control": "no-store" } },
      ),
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
