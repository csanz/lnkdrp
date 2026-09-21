/**
 * One project share link — `PATCH`/`DELETE /api/projects/:projectId/links/:linkId`
 * (docs/prds/lnkdrp-project-links.md, milestone M1).
 *
 * PATCH changes a link's settings (including disable/enable, which is how a project link is
 * revoked without deleting it). DELETE soft-archives it: the link stops resolving, its analytics
 * stay attached to its `shareId`, and the default link refuses to be archived (400) because
 * `/p/:shareId` is the URL every recipient already holds.
 *
 * Neither is a plan decision — the Pro gate is on *creating* a second link. A workspace that drops
 * to Free keeps editing and revoking the links it has.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { ShareLinkError } from "@/lib/share/links";
import {
  archiveProjectLink,
  listProjectLinks,
  projectLinkStatsByShareId,
  setDefaultProjectLink,
  toProjectLinkDTO,
  updateProjectLink,
} from "@/lib/share/projectLinks";
import { accessProjectForLinks, linkErrorResponse } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Throw `not_found` unless the link belongs to the project in the path.
 *
 * The service scopes links by workspace and kind, so without this an admin could patch another
 * project's link through any project id they can reach — and a document link's id must not resolve
 * here at all, which `listProjectLinks` guarantees by only ever returning project rows.
 */
async function assertLinkOnProject(orgId: Types.ObjectId, projectId: Types.ObjectId, linkId: string): Promise<void> {
  const links = await listProjectLinks({ orgId, projectId, includeArchived: true });
  if (!links.some((l) => String(l._id) === linkId)) throw new ShareLinkError("not_found", "Link not found.");
}

/** Settings a PATCH may carry; anything absent is left untouched. */
type ProjectLinkPatch = Partial<{
  label: string;
  audience: string | null;
  enabled: boolean;
  allowDownload: boolean;
  expiresAt: string | null;
  password: string | null;
  /** `true` promotes this link to the project's default; `false` is meaningless and ignored. */
  isDefault: boolean;
}>;

/**
 * `PATCH /api/projects/:projectId/links/:linkId`
 *
 * In: any subset of `{ label, audience, enabled, allowDownload, expiresAt, password }`
 * (`password: null` clears it, a string sets it — the same scrypt + AES material document links
 * use, so `verifySharePassword` and the share-auth cookie work unchanged). Out: `{ link }`.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ projectSlug: string; linkId: string }> }) {
  const { projectSlug, linkId } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "admin");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId, name } = gate.access;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }
    const body = (await request.json().catch(() => ({}))) as ProjectLinkPatch;
    const settings: ProjectLinkPatch = {};
    if (typeof body.label === "string") settings.label = body.label;
    if (body.audience !== undefined) settings.audience = body.audience;
    if (typeof body.enabled === "boolean") settings.enabled = body.enabled;
    if (typeof body.allowDownload === "boolean") settings.allowDownload = body.allowDownload;
    if (body.expiresAt !== undefined) settings.expiresAt = body.expiresAt;
    if (body.password !== undefined) settings.password = body.password;
    // `isDefault` is a promotion, not a setting: it clears the flag on the project's other links,
    // so it has its own service call and is allowed to arrive on its own.
    const promoteDefault = body.isDefault === true;
    if (Object.keys(settings).length === 0 && !promoteDefault) {
      return applyTempUserHeaders(NextResponse.json({ error: "No settings to update." }, { status: 400 }), actor);
    }

    await assertLinkOnProject(orgId, projectId, linkId);
    if (promoteDefault) await setDefaultProjectLink({ orgId, projectId, linkId });
    const { link, restored } = await updateProjectLink({ orgId, linkId, settings });
    const dto = toProjectLinkDTO(link, (await projectLinkStatsByShareId([link.shareId])).get(link.shareId) ?? null);

    void recordActivity({
      orgId: String(orgId),
      userId: actor.userId,
      actorKind: actor.kind,
      type: "share_link.updated",
      projectId,
      title: name,
      meta: {
        scope: "project",
        linkId: dto.id,
        shareId: dto.shareId,
        linkLabel: dto.label,
        projectName: name,
        changed: [...Object.keys(settings), ...(promoteDefault ? ["isDefault"] : [])],
        enabled: dto.enabled,
        // New values for the feed's wording. The password is reduced to set/cleared; the secret is never logged.
        values: {
          ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
          ...(settings.allowDownload !== undefined ? { allowDownload: settings.allowDownload } : {}),
          ...(settings.label !== undefined ? { label: dto.label } : {}),
          ...(settings.expiresAt !== undefined ? { expires: settings.expiresAt ? "set" : "cleared" } : {}),
          ...(settings.password !== undefined ? { password: settings.password ? "set" : "cleared" } : {}),
        },
      },
      request,
    });

    // Enabling a link can republish the project page and bring back the links that page switch had
    // taken down. That is a change to who can reach the room, so it is reported rather than left
    // for the caller to discover by listing.
    const warnings = restored?.length
      ? [
          `Turning this link on republished the project's public page, which also restored ${restored.length} link(s) ` +
            `that were disabled when the page was switched off: ${restored
              .map((l) => (typeof l.label === "string" && l.label.trim() ? l.label.trim() : l.shareId))
              .join(", ")}. Links revoked individually were not restored.`,
        ]
      : [];
    return applyTempUserHeaders(
      NextResponse.json({ link: dto, ...(warnings.length ? { warnings } : {}) }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}

/**
 * `DELETE /api/projects/:projectId/links/:linkId`
 *
 * Soft-archives the link and returns `204`. The default link cannot be archived: that is a `400`
 * (`code: "validation"`), and the caller should disable it instead.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ projectSlug: string; linkId: string }> }) {
  const { projectSlug, linkId } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "admin");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId, name } = gate.access;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }
    await assertLinkOnProject(orgId, projectId, linkId);
    const link = await archiveProjectLink({ orgId, linkId });

    void recordActivity({
      orgId: String(orgId),
      userId: actor.userId,
      actorKind: actor.kind,
      type: "share_link.revoked",
      projectId,
      title: name,
      meta: { scope: "project", linkId: String(link._id), shareId: link.shareId, linkLabel: link.label, projectName: name },
      request,
    });

    return applyTempUserHeaders(new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } }), actor);
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
