/**
 * API route for `/api/download/bootstrap`.
 *
 * Validates an approved download claim token and, if valid, sets the invite-gating cookie (`ld_invite_ok`)
 * so the recipient can proceed through NextAuth sign-in.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { withApiErrorLogging } from "@/lib/errors/withApiErrorLogging";

export const runtime = "nodejs";

const INVITE_COOKIE_NAME = "ld_invite_ok";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export const GET = withApiErrorLogging(async (request: NextRequest) => {
  const token = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!token) return NextResponse.json({ ok: false, error: "Missing token" }, { status: 400 });

  await connectMongo();
  const claimTokenHash = sha256Hex(token);
  const reqDoc = await ShareDownloadRequestModel.findOne({
    claimTokenHash,
    status: "approved",
  })
    .select({ _id: 1, approvedAt: 1 })
    .lean();

  const approvedAt = reqDoc && (reqDoc as unknown as { approvedAt?: unknown }).approvedAt;
  const approved = approvedAt instanceof Date;
  // Simple expiry: stop bootstrapping very old tokens.
  const expired = approved ? approvedAt.getTime() < Date.now() - 1000 * 60 * 60 * 24 * 30 : true; // 30 days

  if (!reqDoc || !approved || expired) {
    return NextResponse.json({ ok: false, error: "Invalid or expired token" }, { status: 404 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: INVITE_COOKIE_NAME,
    value: "1",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Short-ish: this is only to help the recipient complete sign-in.
    maxAge: 60 * 60 * 24 * 3, // 3 days
  });
  return res;
});

