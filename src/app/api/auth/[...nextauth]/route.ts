import NextAuth from "next-auth";
import { getToken } from "next-auth/jwt";
import { NextRequest, NextResponse } from "next/server";
import { authOptions, INVITE_COOKIE_NAME, verifyInviteCookieValue } from "@/lib/auth";

// Force Node.js runtime (Mongoose isn't compatible with Edge runtime).
export const runtime = "nodejs";

const handler = NextAuth(authOptions);

/**
 * Return whether the request carries a valid (signed, unexpired) NextAuth JWT.
 *
 * Cookie *presence* is not enough: anyone can set a cookie named `next-auth.session-token`.
 */
async function hasValidNextAuthSession(req: NextRequest): Promise<boolean> {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    const t = token as { sub?: unknown; userId?: unknown } | null;
    return Boolean(
      (typeof t?.userId === "string" && t.userId) || (typeof t?.sub === "string" && t.sub),
    );
  } catch {
    return false;
  }
}

/**
 * Return whether the caller may reach the sign-in/callback endpoints.
 *
 * Allowed when:
 * - not running in production (local/ngrok dev flows without invite gating), or
 * - the request carries a valid HMAC-signed invite cookie, or
 * - the request is already authenticated (verified JWT, not just a cookie name).
 */
async function canUseAuth(req: NextRequest): Promise<boolean> {
  // In development, allow auth flows without invite gating.
  // This prevents NextAuth (Google OAuth) from failing behind ngrok/local when the invite cookie isn't set.
  if (process.env.NODE_ENV !== "production") return true;
  if (verifyInviteCookieValue(req.cookies.get(INVITE_COOKIE_NAME)?.value).ok) return true;
  // Allow already-authenticated users (valid session JWT) to access auth endpoints.
  if (await hasValidNextAuthSession(req)) return true;
  return false;
}
/**
 * Action From Pathname (uses filter, split).
 */


function actionFromPathname(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  // /api/auth/<action>/...
  return parts[2] ?? "";
}
/**
 * Handle GET requests.
 */


export async function GET(req: NextRequest, ctx: unknown) {
  const action = actionFromPathname(req.nextUrl.pathname);
  if ((action === "signin" || action === "callback") && !(await canUseAuth(req))) {
    return NextResponse.json({ error: "Invite required" }, { status: 403 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handler as any)(req, ctx);
}
/**
 * Handle POST requests.
 */


export async function POST(req: NextRequest, ctx: unknown) {
  const action = actionFromPathname(req.nextUrl.pathname);
  if ((action === "signin" || action === "callback") && !(await canUseAuth(req))) {
    return NextResponse.json({ error: "Invite required" }, { status: 403 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handler as any)(req, ctx);
}
