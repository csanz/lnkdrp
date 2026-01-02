/**
 * API route for `/api/org-invites/email`.
 *
 * POST: create an org invite link and email it to a recipient (owner/admin only).
 *
 * Note: this does not change invite redemption behavior (still `/api/org-invites/claim`).
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { OrgModel } from "@/lib/models/Org";
import { resolveActor } from "@/lib/gating/actor";
import { sendOrgInviteEmail } from "@/lib/email/sendOrgInviteEmail";

export const runtime = "nodejs";

const ENC_IV_BYTES = 12;

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function getInviteTokenSecret(): string {
  const s = process.env.LNKDRP_ORG_INVITE_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;
  if (process.env.NODE_ENV !== "production") return "dev-lnkrdp-org-invite-token-secret";
  throw new Error("Missing LNKDRP_ORG_INVITE_TOKEN_SECRET (or NEXTAUTH_SECRET) for org invite tokens");
}

function getEncryptionKey(): Buffer {
  return crypto.createHash("sha256").update(getInviteTokenSecret()).digest();
}

function encryptInviteToken(token: string): { enc: string; iv: string; tag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(ENC_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: enc.toString("base64url"), iv: iv.toString("base64url"), tag: tag.toString("base64url") };
}

function originFromRequest(request: Request): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

function isValidEmail(email: string): boolean {
  const e = email.trim();
  if (!e || e.length > 320) return false;
  // Lightweight validation. We only need to catch obvious mistakes.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<{
    orgId: string;
    role: "admin" | "member" | "viewer";
    ttlDays: number;
    email: string;
  }>;

  const orgIdRaw = typeof body.orgId === "string" ? body.orgId.trim() : actor.orgId;
  const role = body.role === "admin" || body.role === "viewer" ? body.role : "member";
  const ttlDaysRaw = typeof body.ttlDays === "number" ? body.ttlDays : 14;
  const ttlDays = Math.max(1, Math.min(30, Math.floor(ttlDaysRaw)));
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) {
    return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  await connectMongo();

  const membership = await OrgMembershipModel.findOne({
    orgId: new Types.ObjectId(orgIdRaw),
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
  })
    .select({ role: 1 })
    .lean();
  const userRole = membership ? String((membership as { role?: unknown }).role ?? "") : "";
  const canInvite = userRole === "owner" || userRole === "admin";
  if (!canInvite) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgIdRaw), isDeleted: { $ne: true } })
    .select({ name: 1 })
    .lean();
  const orgName = org ? String((org as { name?: unknown }).name ?? "").trim() : "";
  if (!orgName) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const token = crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256Hex(token);
  const tokenEncrypted = encryptInviteToken(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const created = await OrgInviteModel.create({
    orgId: new Types.ObjectId(orgIdRaw),
    createdByUserId: new Types.ObjectId(actor.userId),
    tokenHash,
    tokenEnc: tokenEncrypted.enc,
    tokenEncIv: tokenEncrypted.iv,
    tokenEncTag: tokenEncrypted.tag,
    role,
    recipientEmail: email,
    expiresAt,
    isRevoked: false,
    redeemedByUserId: null,
    redeemedAt: null,
  });
  const doc = Array.isArray(created) ? created[0] : created;
  const inviteId = String((doc as unknown as { _id: Types.ObjectId })._id);

  const origin = originFromRequest(request);
  const inviteUrl = origin ? `${origin}/org/join/${encodeURIComponent(token)}` : `/org/join/${encodeURIComponent(token)}`;

  await sendOrgInviteEmail({
    to: email,
    orgName,
    inviteUrl,
    role,
    invitedByEmail: actor.email ?? null,
  });

  return NextResponse.json({
    ok: true,
    invite: { id: inviteId, role, expiresAt: expiresAt.toISOString(), inviteUrl, email },
  });
}


