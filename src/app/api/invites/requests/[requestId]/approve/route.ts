import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { InviteModel } from "@/lib/models/Invite";
import { UserModel } from "@/lib/models/User";
import { sendInviteApprovalEmail } from "@/lib/email/sendInviteApprovalEmail";

export const runtime = "nodejs";
/**
 * Return whether localhost request.
 */


function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}
/**
 * Require Admin (uses isLocalhostRequest, resolveActor, isValid).
 */


async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}
/**
 * Generate Invite Code (uses randomBytes).
 */


function generateInviteCode() {
  // 5 chars, A-Z and 0-9, all caps (easy to read/type).
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(5);
  let out = "";
  for (let i = 0; i < 5; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
/**
 * Handle POST requests.
 */


export async function POST(
  request: Request,
  ctx: { params: Promise<{ requestId: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { requestId } = await ctx.params;
  if (!Types.ObjectId.isValid(requestId)) {
    return NextResponse.json({ error: "Invalid requestId" }, { status: 400 });
  }

  await connectMongo();

  const reqDoc = await InviteModel.findOne({
    _id: new Types.ObjectId(requestId),
    kind: "request",
  })
    .select({ requestEmail: 1, requestDescription: 1, approvedDate: 1 })
    .lean();

  if (!reqDoc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((reqDoc as { approvedDate?: unknown }).approvedDate) {
    return NextResponse.json({ error: "Already approved" }, { status: 409 });
  }

  const to = (reqDoc as { requestEmail?: unknown }).requestEmail;
  const description = (reqDoc as { requestDescription?: unknown }).requestDescription;
  if (typeof to !== "string" || !to.trim()) {
    return NextResponse.json({ error: "Request is missing email" }, { status: 400 });
  }

  // Create an invite code (unique) + send email + mark request approved.
  let inviteId: Types.ObjectId | null = null;
  let inviteCode: string | null = null;

  try {
    // Best-effort uniqueness loop.
    for (let i = 0; i < 6; i++) {
      const code = generateInviteCode();
      try {
        const created = await InviteModel.create({
          kind: "invite",
          code,
          isActive: true,
        });
        inviteId = created._id as Types.ObjectId;
        inviteCode = code;
        break;
      } catch {
        // retry
      }
    }

    if (!inviteId || !inviteCode) {
      return NextResponse.json({ error: "Failed to generate invite code" }, { status: 500 });
    }

    await sendInviteApprovalEmail({
      to: to.trim().toLowerCase(),
      inviteCode,
      description: typeof description === "string" ? description : null,
    });

    const now = new Date();
    await InviteModel.updateOne(
      { _id: new Types.ObjectId(requestId), kind: "request", approvedDate: null },
      {
        $set: {
          approvedDate: now,
          approvedByUserId: auth.userId ? new Types.ObjectId(auth.userId) : null,
          approvedInviteId: inviteId,
          approvedInviteCode: inviteCode,
          approvalEmailSentDate: now,
          approvalEmailError: null,
        },
      },
    );

    return NextResponse.json({ ok: true, inviteCode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Try to record email error on the request (without approving).
    await InviteModel.updateOne(
      { _id: new Types.ObjectId(requestId), kind: "request", approvedDate: null },
      { $set: { approvalEmailError: message } },
    ).catch(() => void 0);

    // Roll back the invite if we created one but didn't approve.
    if (inviteId) {
      await InviteModel.deleteOne({ _id: inviteId, kind: "invite" }).catch(() => void 0);
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}


