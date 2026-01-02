import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const INVITE_COOKIE_NAME = "ld_invite_ok";
/**
 * Handle GET requests.
 */


export async function GET(request: NextRequest) {
  const ok = Boolean(request.cookies.get(INVITE_COOKIE_NAME)?.value);
  return NextResponse.json({ ok });
}


