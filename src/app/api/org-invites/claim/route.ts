/**
 * API route for `/api/org-invites/claim`.
 *
 * Redeem an invite token into an org membership (auth required).
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import { debugError, debugLog } from "@/lib/debug";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function POST(request: Request) {
  try {
    debugLog(2, "[api/org-invites/claim] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{ token: string }>;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });

    await connectMongo();

    const tokenHash = sha256Hex(token);
    const invite = await OrgInviteModel.findOne({ tokenHash, isRevoked: { $ne: true } })
      .select({ _id: 1, orgId: 1, role: 1, expiresAt: 1, redeemedAt: 1 })
      .lean();

    const expiresAt = invite && (invite as unknown as { expiresAt?: unknown }).expiresAt;
    const expired = !(expiresAt instanceof Date) || expiresAt.getTime() <= Date.now();
    const redeemedAt = invite && (invite as unknown as { redeemedAt?: unknown }).redeemedAt;
    const redeemed = redeemedAt instanceof Date;

    if (!invite || expired || redeemed) {
      return NextResponse.json({ error: "Invalid or expired invite" }, { status: 404 });
    }

    const orgId = String((invite as unknown as { orgId?: unknown }).orgId ?? "");
    if (!orgId || !Types.ObjectId.isValid(orgId)) {
      return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
    }

    // Personal workspaces are single-user; joining via invite is never allowed.
    const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgId), isDeleted: { $ne: true } })
      .select({ type: 1 })
      .lean();
    const orgType = org ? String((org as { type?: unknown }).type ?? "") : "";
    if (orgType !== "team") {
      return NextResponse.json({ error: "Invalid or expired invite" }, { status: 404 });
    }

    const roleRaw = String((invite as unknown as { role?: unknown }).role ?? "member");
    const role = roleRaw === "admin" || roleRaw === "viewer" ? roleRaw : "member";

    const now = new Date();
    const userId = new Types.ObjectId(actor.userId);
    const orgObjectId = new Types.ObjectId(orgId);

    // Upsert membership for the invited user.
    //
    // Important: Don't set the same path in multiple update operators (Mongo error code 40).
    await OrgMembershipModel.updateOne(
      { orgId: orgObjectId, userId },
      {
        $setOnInsert: {
          orgId: orgObjectId,
          userId,
          role,
          createdDate: now,
        },
        $set: { isDeleted: false, updatedDate: now },
      },
      { upsert: true },
    );

    // Mark invite as redeemed (best-effort; single-use).
    await OrgInviteModel.updateOne(
      { _id: (invite as unknown as { _id: Types.ObjectId })._id, redeemedAt: null },
      { $set: { redeemedAt: now, redeemedByUserId: userId, updatedDate: now } },
    );

    return NextResponse.json({ ok: true, orgId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const name = err instanceof Error ? err.name : "UnknownError";
    const code = (err as unknown as { code?: unknown }).code;
    const mongoCode = typeof code === "number" ? code : null;

    debugError(1, "[api/org-invites/claim] POST failed", {
      name,
      message,
      mongoCode,
    });

    const suffix = mongoCode ? ` (mongoCode=${mongoCode})` : "";
    return NextResponse.json({ error: `ORG_INVITE_CLAIM_FAILED: ${message}${suffix}` }, { status: 500 });
  }
}


