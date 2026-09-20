import { NextResponse } from "next/server";
import crypto from "node:crypto";

import { recordActivity } from "@/lib/activity/log";
import { resolveShareLink } from "@/lib/share/links";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { shareAuthCookieName, shareAuthCookieValue, verifySharePassword } from "@/lib/sharePassword";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";

/** Password attempts per IP per share (brute-force protection). */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;
/**
 * Attempts against ONE link, counted across every source address together.
 *
 * The per-IP bucket above was the only bound, and a bound that is per-IP is not a bound: ten
 * proxies buy ten times the guesses, and share passwords have no minimum length by design
 * (`SHARE_PASSWORD_MIN = 1`, a settled product decision — the limiter is what stands in for a
 * length rule). This bucket is the one an attacker cannot buy their way out of, because spreading
 * the attempts is what it counts.
 *
 * The ceiling is deliberately far above real use rather than tight: exhausting it locks the link
 * for everyone until the window ends, so it has to be a number no audience reaches by opening the
 * link they were sent. A hundred unlocks in a quarter of an hour on a single link is already an
 * order of magnitude past the busiest real send.
 */
const UNLOCK_SHARE_LIMIT = 100;
const UNLOCK_SHARE_WINDOW_MS = 15 * 60 * 1000;
/**
 * Extra hits a wrong password costs the share-wide bucket, on top of the one every attempt costs.
 *
 * The limiter counts hits, not outcomes, so a bucket that blocks guessing also blocks a crowd of
 * recipients typing the right password. Charging a failure more than a success tilts the budget
 * towards the case it exists for: a guesser burns the window twice as fast as the audience does,
 * which buys a ceiling high enough to be safe for a real send and still low enough to bite.
 */
const UNLOCK_FAILURE_PENALTY = 1;
/**
 * Attempts from one IP against EVERY link.
 *
 * The per-(IP, share) bucket resets per slug, so one host could walk a list of guessed slugs at
 * full speed. This is the bound on that, and it is the loosest of the three on purpose: one
 * address here is often one office behind a NAT, and `clientIpFromRequest` collapses callers with
 * no forwarding header into a single `"unknown"` bucket, so anything tight would refuse real
 * recipients. Any one link stays tight regardless — that is what the two buckets above are for.
 */
const UNLOCK_IP_LIMIT = 60;
const UNLOCK_IP_WINDOW_MS = 5 * 60 * 1000;
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}
/**
 * Handle POST requests.
 */


export async function POST(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  try {
    const { shareId } = await ctx.params;
    if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as unknown;
    const password = asNonEmptyString((body as { password?: unknown }).password);
    // The gate sends the same device id the viewer uses, so the unlock can be attributed to the
    // same person as the reading that follows — and renamed by the activity feed's `viewerKey` join
    // the moment they introduce themselves. Optional: a browser that refuses storage still unlocks.
    const botId = asNonEmptyString((body as { botId?: unknown }).botId);
    if (!password) return NextResponse.json({ error: "Missing password" }, { status: 400 });

    // Count every attempt (valid or not) against three buckets, so guessing is bounded whichever
    // way it is spread: per (IP, share), per share across all IPs, and per IP across all shares.
    // All three are counted before the link is looked up, which also keeps a flood of guesses off
    // Mongo and off `verifySharePassword`'s scrypt (each call is deliberate CPU, so an unbounded
    // guesser is a load problem as well as a secrecy one).
    const ip = clientIpFromRequest(request);
    const shareKey = `unlock:share:${shareId}`;
    const [rlIpShare, rlShare, rlIp] = await Promise.all([
      rateLimit({ key: `unlock:${ip}:${shareId}`, limit: UNLOCK_LIMIT, windowMs: UNLOCK_WINDOW_MS }),
      rateLimit({ key: shareKey, limit: UNLOCK_SHARE_LIMIT, windowMs: UNLOCK_SHARE_WINDOW_MS }),
      rateLimit({ key: `unlock:ip:${ip}`, limit: UNLOCK_IP_LIMIT, windowMs: UNLOCK_IP_WINDOW_MS }),
    ]);
    if (!rlIpShare.ok) return rateLimitedResponse(rlIpShare, "Too many attempts. Please try again later.");
    if (!rlShare.ok) return rateLimitedResponse(rlShare, "Too many attempts on this link. Please try again later.");
    if (!rlIp.ok) return rateLimitedResponse(rlIp, "Too many attempts. Please try again later.");

    // The password lives on the link, so each recipient's link unlocks independently
    // (docs/prds/lnkdrp-multi-links.md). A refused link is a 404, like an unknown slug.
    //
    // A project link's slug unlocks here too, and through the same gate component: the cookie is
    // named for the slug and scoped to `path: "/"`, so one unlock covers `/p/:shareId` and every
    // `/p/:shareId/:docId` behind it. `resolveShareLink` refuses project slugs by design
    // (docs/prds/lnkdrp-project-links.md), hence the second lookup rather than a widened first one.
    const resolved = (await resolveShareLink(shareId)) ?? (await resolveProjectLink(shareId));
    if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const hash = resolved.link.passwordHash;
    const salt = resolved.link.passwordSalt;
    const enabled = typeof hash === "string" && Boolean(hash) && typeof salt === "string" && Boolean(salt);

    if (!enabled) {
      // Not password protected.
      return NextResponse.json({ ok: true, sharePasswordEnabled: false });
    }

    const ok = verifySharePassword({ password, salt: salt as string, hash: hash as string });
    if (!ok) {
      // Charge the wrong guess the rest of its price (see UNLOCK_FAILURE_PENALTY). The answer is
      // the same 401 either way — the extra hits only shorten how long the window lasts for a
      // caller that keeps getting it wrong, and the response says nothing about the budget, so a
      // guesser cannot read the penalty back as a signal.
      for (let i = 0; i < UNLOCK_FAILURE_PENALTY; i++) {
        await rateLimit({ key: shareKey, limit: UNLOCK_SHARE_LIMIT, windowMs: UNLOCK_SHARE_WINDOW_MS });
      }
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    /**
     * A protected link's one moment of truth: the password reached the right person and was used.
     *
     * Recorded on success only. A wrong password is bounded by the limiter above and is far more
     * often a recipient mistyping than anyone guessing, so announcing every attempt would bury the
     * event that matters in the event that doesn't.
     */
    const link = resolved.link as { orgId?: unknown; docId?: unknown; projectId?: unknown; label?: unknown; isDefault?: unknown };
    /**
     * The owning side is recorded everywhere and announced nowhere — the rule every other
     * recipient event in this product follows (`isOwnerSideViewer`). Without it, an owner testing
     * their own password wrote "Someone entered the password for X" into their own feed, and on
     * Free the identity is stripped, so it read as an unknown outsider getting in.
     */
    const unlockSession = await tryResolveAuthUserId(request);
    const ownerSide = await isOwnerSideViewer(
      { orgId: link.orgId, userId: (resolved.link as { createdByUserId?: unknown }).createdByUserId },
      unlockSession?.userId ?? null,
    );
    if (link.orgId && !ownerSide) {
      void recordActivity({
        orgId: String(link.orgId),
        actorKind: "viewer",
        type: "share.unlocked",
        docId: link.docId ? String(link.docId) : null,
        projectId: link.projectId ? String(link.projectId) : null,
        meta: {
          shareId,
          ...(botId ? { viewerKey: crypto.createHash("sha256").update(botId).digest("hex") } : {}),
          linkLabel: typeof link.label === "string" ? link.label : null,
          isDefaultLink: Boolean(link.isDefault),
        },
        request,
      });
    }

    const res = NextResponse.json({ ok: true, sharePasswordEnabled: true });
    res.cookies.set({
      name: shareAuthCookieName(shareId),
      value: shareAuthCookieValue({ shareId, sharePasswordHash: hash as string }),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      // Must be visible to both `/s/:shareId/*` (viewer + pdf proxy) AND `/api/share/:shareId/*`
      // (e.g. revision history endpoint). Cookie name is shareId-scoped, so widening path is safe.
      path: "/",
      maxAge: 60 * 60 * 24 * 14, // 14 days
    });
    return res;
  } catch (err) {
    return errorJson(err, { status: 400, publicMessage: "Could not unlock this share", context: "[api/share/:shareId/unlock] POST failed" });
  }
}






