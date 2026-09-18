import { NextResponse } from "next/server";
import { resolveShareLink } from "@/lib/share/links";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { shareAuthCookieName, shareAuthCookieValue, verifySharePassword } from "@/lib/sharePassword";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";

/** Password attempts per IP per share (brute-force protection). */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;
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
    if (!password) return NextResponse.json({ error: "Missing password" }, { status: 400 });

    // Count every attempt (valid or not) so guessing is bounded per IP + share.
    const ip = clientIpFromRequest(request);
    const rl = await rateLimit({ key: `unlock:${ip}:${shareId}`, limit: UNLOCK_LIMIT, windowMs: UNLOCK_WINDOW_MS });
    if (!rl.ok) return rateLimitedResponse(rl, "Too many attempts. Please try again later.");

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
    if (!ok) return NextResponse.json({ error: "Invalid password" }, { status: 401 });

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






