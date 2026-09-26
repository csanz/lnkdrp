/**
 * `GET /api/docs/:docId/links/:linkId/password` — show the owner the password on one share link.
 *
 * Until this existed there was no way to find out. Per-link passwords are encrypted at rest
 * (`passwordEnc` via `encryptSharePassword`) precisely so they can be read back, but the only
 * caller of `decryptSharePassword` was the document-level route, which covers the default link
 * alone and nothing in the UI called it. So once a password was set — by a person or by an agent —
 * the only copy the human could see was whatever the agent happened to write in chat. Miss that
 * message and the owner was locked out of their own link, with Change and Remove as the only way
 * forward.
 *
 * Admin or owner only, one step above the `member` the rest of the link routes take: reading a
 * secret back out is not the same permission as setting one. Rate-limited per viewer, `no-store`,
 * and every reveal writes an activity row, so a password that leaves the system leaves a trace.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { rateLimit } from "@/lib/http/rateLimit";
import { decryptSharePassword } from "@/lib/sharePassword";
import { ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { WITH_LINK_PASSWORD } from "@/lib/share/passwordSelect";
import { accessDocForLinks, linkErrorResponse } from "../../shared";
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
export async function GET(request: Request, ctx: { params: Promise<{ docId: string; linkId: string }> }) {
  const { docId, linkId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "admin");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId, title } = gate.access;
  // A key must never hold a secret that outlives its own revocation: revoking the key would
  // not take back a password an agent had already read. See forbidApiKey.
  const keyRefusal = forbidApiKey(actor, "reveal a share password");
  if (keyRefusal) return keyRefusal;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }

    const rl = await rateLimit({ key: `linkpwd:${actor.userId}:${linkId}`, limit: REVEAL_LIMIT, windowMs: REVEAL_WINDOW_MS });
    if (!rl.ok) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } }),
        actor,
      );
    }

    // `includeArchived: true` so a deleted link can be told apart from an id that never existed —
    // the two deserve different answers — and then refused below.
    const link = Types.ObjectId.isValid(linkId)
      ? await ShareLinkModel.findOne({ _id: new Types.ObjectId(linkId), docId: docObjectId, orgId }, WITH_LINK_PASSWORD).lean<ShareLink>()
      : null;
    if (!link) {
      return applyTempUserHeaders(NextResponse.json({ error: "Link not found." }, { status: 404 }), actor);
    }

    /**
     * A deleted link keeps no readable secret.
     *
     * Deleting soft-archives the row, and this route used to read straight through that: the link
     * was gone from the links table, gone from search, and refused by PATCH, while its plaintext
     * password was still retrievable by id. "Deleted" has to mean the same thing everywhere,
     * especially for the one endpoint that hands back a secret — otherwise revoking a link leaves
     * its password quietly readable by anyone who kept the id.
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
        docId: docObjectId,
        title,
        meta: { linkId: String(link._id), shareId: link.shareId, linkLabel: link.label },
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
