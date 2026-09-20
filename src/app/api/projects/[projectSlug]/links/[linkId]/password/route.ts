/**
 * `GET /api/projects/:projectId/links/:linkId/password` — show the owner the password on one
 * project share link.
 *
 * The project-shaped twin of `/api/docs/:docId/links/:linkId/password`, and it exists for the same
 * reason: per-link passwords are encrypted at rest precisely so they can be read back, and without
 * this route a project link's password was write-only — set it once and the only surviving copy was
 * whatever the person (or the agent) happened to write down. Its absence was also the one reason
 * the shared `ShareLinkModal` had to hide `Show` on a project link.
 *
 * `admin` — the same level the PATCH and DELETE handlers take, and the same level the document
 * twin's reveal takes, because the shared `ShareLinkModal` gates its Show button client-side on one
 * `plan.canRevealPassword` flag for both: raising one route without the other would leave a button
 * that renders and then 403s. Rate-limited per viewer, `no-store`, and every reveal writes an
 * activity row so a secret leaving the system leaves a trace.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { rateLimit } from "@/lib/http/rateLimit";
import { decryptSharePassword } from "@/lib/sharePassword";
import { listProjectLinks } from "@/lib/share/projectLinks";
import { accessProjectForLinks, linkErrorResponse } from "../../shared";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generous enough for a person clicking Show, low enough that scripted enumeration is pointless. */
const REVEAL_LIMIT = 30;
const REVEAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Return `{ passwordEnabled, password }` for one link. `password` is null when the link has none,
 * or when it predates encryption-at-rest and only its hash survives.
 */
export async function GET(request: Request, ctx: { params: Promise<{ projectSlug: string; linkId: string }> }) {
  const { projectSlug, linkId } = await ctx.params;
  const gate = await accessProjectForLinks(request, projectSlug, "admin");
  if (!gate.ok) return gate.response;
  const { actor, projectId, orgId, name } = gate.access;
  // A key must never hold a secret that outlives its own revocation: revoking the key would
  // not take back a password an agent had already read. See forbidApiKey.
  const keyRefusal = forbidApiKey(actor, "reveal a share password");
  if (keyRefusal) return keyRefusal;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }

    const rl = await rateLimit({ key: `projlinkpwd:${actor.userId}:${linkId}`, limit: REVEAL_LIMIT, windowMs: REVEAL_WINDOW_MS });
    if (!rl.ok) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } }),
        actor,
      );
    }

    const link = (await listProjectLinks({ orgId, projectId, includeArchived: true })).find((l) => String(l._id) === linkId);
    if (!link) {
      return applyTempUserHeaders(NextResponse.json({ error: "Link not found." }, { status: 404 }), actor);
    }

    /**
     * An archived link's password is not retrievable, the same rule the document twin states.
     *
     * The row is kept so its analytics keep their name, and `includeArchived: true` above is what
     * lets this route find it at all — but "deleted" has to mean the same thing on every endpoint,
     * and this is the one that hands back a secret. Without it, revoking a project link left its
     * plaintext password readable by anyone who kept the id.
     */
    if (link.archivedAt) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "That link was deleted, so its password is no longer available." }, { status: 404 }),
        actor,
      );
    }

    const enabled = Boolean(link.passwordHash);
    // A link that predates encryption-at-rest still has a usable hash but nothing to decrypt. Say
    // so plainly rather than implying the link has no password: the owner's move there is Change.
    const password = enabled ? decryptSharePassword({ enc: link.passwordEnc, iv: link.passwordEncIv, tag: link.passwordEncTag }) : null;

    if (enabled && password) {
      void recordActivity({
        orgId: String(orgId),
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share_link.password_revealed",
        projectId,
        title: name,
        meta: { scope: "project", linkId: String(link._id), shareId: link.shareId, linkLabel: link.label, projectName: name },
        request,
      });
    }

    return applyTempUserHeaders(
      NextResponse.json({ passwordEnabled: enabled, password }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
