import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";
import { INVITE_COOKIE_NAME, INVITE_COOKIE_MAX_AGE_SEC, signInviteCookieValue } from "@/lib/auth";
import { errorJson } from "@/lib/http/errorResponse";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";

export const runtime = "nodejs";

/**
 * Invite codes are short (5 chars, A-Z0-9) and long-lived, so guessing must be expensive:
 * a handful of attempts per IP per window. Every attempt counts (valid or not).
 */
const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
/**
 * Normalize Code (uses toUpperCase, trim, replace).
 */


function normalizeCode(code: string) {
  // Accept common copy/paste formats (spaces/dashes) and normalize for matching.
  return code.replace(/[^a-z0-9]/gi, "").trim().toUpperCase();
}
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


export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as unknown;
    const rawCode = asNonEmptyString((body as { code?: unknown }).code);
    if (!rawCode) return NextResponse.json({ error: "Missing code" }, { status: 400 });

    const rl = await rateLimit({
      key: `invite-verify:ip:${clientIpFromRequest(request)}`,
      limit: VERIFY_LIMIT,
      windowMs: VERIFY_WINDOW_MS,
    });
    if (!rl.ok) return rateLimitedResponse(rl);

    // Support older/manual formats by trying multiple normalized variants.
    const trimmed = rawCode.trim();
    const upperTrimmed = trimmed.toUpperCase();
    const normalized = normalizeCode(rawCode);
    const candidates = Array.from(new Set([trimmed, upperTrimmed, normalized])).filter(Boolean);

    await connectMongo();
    const invite = await InviteModel.findOne({
      kind: "invite",
      code: { $in: candidates },
      isActive: { $ne: false },
    })
      .select({ _id: 1 })
      .lean();

    if (!invite) return NextResponse.json({ error: "Invalid invite code" }, { status: 401 });

    // Signed value (`<inviteId>.<expiresUnix>.<hmac>`): the NextAuth gate verifies signature + expiry,
    // so a hand-crafted cookie cannot bypass invite gating.
    const res = NextResponse.json({ ok: true });
    res.cookies.set({
      name: INVITE_COOKIE_NAME,
      value: signInviteCookieValue({ inviteId: String(invite._id), ttlSec: INVITE_COOKIE_MAX_AGE_SEC }),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: INVITE_COOKIE_MAX_AGE_SEC, // 14 days
    });
    return res;
  } catch (err) {
    return errorJson(err, { status: 400, publicMessage: "Could not verify invite code", context: "[api/invites/verify] POST failed" });
  }
}


