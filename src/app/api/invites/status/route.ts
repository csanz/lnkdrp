import { NextRequest, NextResponse } from "next/server";
import { withApiErrorLogging } from "@/lib/errors/withApiErrorLogging";

export const runtime = "nodejs";

const INVITE_COOKIE_NAME = "ld_invite_ok";
/**
 * Handle GET requests.
 */


export const GET = withApiErrorLogging(async (request: NextRequest) => {
  const ok = Boolean(request.cookies.get(INVITE_COOKIE_NAME)?.value);
  return NextResponse.json({ ok });
});


