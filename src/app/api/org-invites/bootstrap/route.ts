/**
 * API route for `/api/org-invites/bootstrap`.
 *
 * Validates an org invite token and, if valid, sets the invite-gating cookie (`ld_invite_ok`)
 * so the recipient can proceed through NextAuth sign-in.
 */
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
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
  const tokenHash = sha256Hex(token);
  const invite = await OrgInviteModel.findOne({ tokenHash, isRevoked: { $ne: true } })
    .select({ _id: 1, expiresAt: 1, redeemedAt: 1 })
    .lean();

  const expiresAt = invite && (invite as unknown as { expiresAt?: unknown }).expiresAt;
  const expired = !(expiresAt instanceof Date) || expiresAt.getTime() <= Date.now();
  const redeemedAt = invite && (invite as unknown as { redeemedAt?: unknown }).redeemedAt;
  const redeemed = redeemedAt instanceof Date;

  if (!invite || expired || redeemed) {
    return NextResponse.json({ ok: false, error: "Invalid or expired invite" }, { status: 404 });
  }

  const res = NextResponse.json({ ok: true });
  // Allow auth endpoints to proceed for invite recipients.
  res.cookies.set({
    name: INVITE_COOKIE_NAME,
    value: "1",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Short-ish: recipients can still log in later, but this shouldn't be a permanent bypass.
    maxAge: 60 * 60 * 24 * 3, // 3 days
  });
  return res;
});



