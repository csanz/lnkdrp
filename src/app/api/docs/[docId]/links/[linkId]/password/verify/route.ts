/**
 * `POST /api/docs/:docId/links/:linkId/password/verify` — does this password open this link?
 *
 * The owner-side counterpart to the recipient's unlock route, and deliberately not the same thing.
 * `POST /api/share/:shareId/unlock` is the only other way to test a password, and using it to
 * check one would do three things an owner never wants: set a share auth cookie, count toward the
 * recipient-facing limit of 10 attempts per IP per share per 5 minutes — so an agent checking a
 * password could lock out the person the link is for — and put traffic on a link nobody opened.
 *
 * This route does none of that. It compares against the stored scrypt hash and answers, with its
 * own limiter keyed to the caller rather than the share. Nothing is written: no cookie, no view,
 * no activity row. A reveal is the event worth recording, and that is the sibling GET.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { applyTempUserHeaders } from "@/lib/gating/actor";
import { rateLimit } from "@/lib/http/rateLimit";
import { verifySharePassword } from "@/lib/sharePassword";
import { ShareLinkModel, type ShareLink } from "@/lib/models/ShareLink";
import { accessDocForLinks, linkErrorResponse } from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Own limiter, keyed to the caller and link — never the recipient's share-facing unlock bucket. */
const VERIFY_LIMIT = 20;
const VERIFY_WINDOW_MS = 5 * 60 * 1000;

/** Returns `{ passwordEnabled, matches }`. `matches` is false whenever the link has no password. */
export async function POST(request: Request, ctx: { params: Promise<{ docId: string; linkId: string }> }) {
  const { docId, linkId } = await ctx.params;
  const gate = await accessDocForLinks(request, docId, "admin");
  if (!gate.ok) return gate.response;
  const { actor, docId: docObjectId, orgId } = gate.access;
  try {
    if (!Types.ObjectId.isValid(linkId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid linkId" }, { status: 400 }), actor);
    }
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    /**
     * Normalise the candidate the way every other side of this password already does.
     *
     * What is stored is trimmed: `passwordFields` hashes `password.trim()` when the link is set up.
     * What the recipient types is trimmed too — the unlock route runs the body through
     * `asNonEmptyString` before `verifySharePassword`. This route compared the raw body, so a
     * candidate carrying whitespace (and a pasted password usually does) came back `matches: false`
     * for a string that opens the link. The owner, checking the password they had just sent, was
     * told it was wrong and changed a link that worked.
     *
     * A whitespace-only body is nothing to check, so it takes the same 400 an empty one does —
     * unlock answers it the same way ("Missing password").
     */
    const candidate = typeof body.password === "string" ? body.password.trim() : "";
    if (!candidate) {
      return applyTempUserHeaders(NextResponse.json({ error: "password is required." }, { status: 400 }), actor);
    }

    const rl = await rateLimit({ key: `linkpwdverify:${actor.userId}:${linkId}`, limit: VERIFY_LIMIT, windowMs: VERIFY_WINDOW_MS });
    if (!rl.ok) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } }),
        actor,
      );
    }

    // `includeArchived: true` so a deleted link can be told apart from an id that never existed,
    // and then refused below.
    const link = Types.ObjectId.isValid(linkId)
      ? await ShareLinkModel.findOne({ _id: new Types.ObjectId(linkId), docId: docObjectId, orgId }).lean<ShareLink>()
      : null;
    if (!link) {
      return applyTempUserHeaders(NextResponse.json({ error: "Link not found." }, { status: 404 }), actor);
    }

    /**
     * A deleted link has no password to confirm.
     *
     * This answered `matches: true` for a link that no longer resolves, which is the wrong answer
     * to the only question the endpoint is asked: "will this password let my recipient in?" It will
     * not — there is nothing for them to open. Worse alongside the reveal route, which handed back
     * the plaintext of the same dead link until it was fixed: between them, a revoked link's secret
     * stayed both readable and confirmable by anyone holding its id.
     */
    if (link.archivedAt) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "That link was deleted, so its password no longer opens anything." }, { status: 404 }),
        actor,
      );
    }

    const passwordEnabled = Boolean(link.passwordHash);
    const matches = passwordEnabled && verifySharePassword({ password: candidate, salt: link.passwordSalt, hash: link.passwordHash });

    return applyTempUserHeaders(
      NextResponse.json({ passwordEnabled, matches }, { headers: { "cache-control": "no-store" } }),
      actor,
    );
  } catch (err) {
    return linkErrorResponse(err, actor);
  }
}
