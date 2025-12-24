import NextAuth from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";

// Force Node.js runtime (Mongoose isn't compatible with Edge runtime).
export const runtime = "nodejs";

const handler = NextAuth(authOptions);

const INVITE_COOKIE_NAME = "ld_invite_ok";

function hasNextAuthSessionCookie(req: NextRequest) {
  return Boolean(
    req.cookies.get("next-auth.session-token")?.value ||
      req.cookies.get("__Secure-next-auth.session-token")?.value,
  );
}

function canUseAuth(req: NextRequest) {
  if (req.cookies.get(INVITE_COOKIE_NAME)?.value) return true;
  // Allow already-authenticated users (session cookie present) to access auth endpoints.
  if (hasNextAuthSessionCookie(req)) return true;
  return false;
}

function actionFromPathname(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  // /api/auth/<action>/...
  return parts[2] ?? "";
}

export async function GET(req: NextRequest, ctx: unknown) {
  const action = actionFromPathname(req.nextUrl.pathname);
  if ((action === "signin" || action === "callback") && !canUseAuth(req)) {
    return NextResponse.json({ error: "Invite required" }, { status: 403 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handler as any)(req, ctx);
}

export async function POST(req: NextRequest, ctx: unknown) {
  const action = actionFromPathname(req.nextUrl.pathname);
  if ((action === "signin" || action === "callback") && !canUseAuth(req)) {
    return NextResponse.json({ error: "Invite required" }, { status: 403 });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (handler as any)(req, ctx);
}




