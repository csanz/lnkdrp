import { NextRequest, NextResponse } from "next/server";
import { withApiErrorLogging } from "@/lib/errors/withApiErrorLogging";
import { INVITE_COOKIE_NAME, verifyInviteCookieValue } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Handle GET requests.
 */


export const GET = withApiErrorLogging(async (request: NextRequest) => {
  const ok = verifyInviteCookieValue(request.cookies.get(INVITE_COOKIE_NAME)?.value).ok;
  return NextResponse.json({ ok });
});


