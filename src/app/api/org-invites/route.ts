/**
 * API route for `/api/org-invites`.
 *
 * - POST: create a new org invite link (owner/admin only).
 *
 * Notes:
 * - Invite tokens are returned only once (plaintext is never stored).
 * - Invite redemption is handled by `/api/org-invites/claim`.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { OrgModel } from "@/lib/models/Org";
import { tryResolveAuthUserId } from "@/lib/gating/actor";

export const runtime = "nodejs";

const ENC_IV_BYTES = 12;

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function getInviteTokenSecret(): string {
  // Prefer a dedicated secret, but fall back to NEXTAUTH_SECRET when available.
  const s = process.env.LNKDRP_ORG_INVITE_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (s) return s;
  // Dev fallback so local envs don't crash.
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

function decryptInviteToken(args: { enc?: unknown; iv?: unknown; tag?: unknown }): string | null {
  const enc = typeof args.enc === "string" ? args.enc : "";
  const iv = typeof args.iv === "string" ? args.iv : "";
  const tag = typeof args.tag === "string" ? args.tag : "";
  if (!enc || !iv || !tag) return null;
  try {
    const key = getEncryptionKey();
    const ivBuf = Buffer.from(iv, "base64url");
    const tagBuf = Buffer.from(tag, "base64url");
    const encBuf = Buffer.from(enc, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf);
    decipher.setAuthTag(tagBuf);
    const out = Buffer.concat([decipher.update(encBuf), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}

function originFromRequest(request: Request): string {
  try {
    // Use request origin so local/dev links work even without NEXT_PUBLIC_SITE_URL.
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

export async function GET(request: Request) {
  const session = await tryResolveAuthUserId(request);
  if (!session?.userId) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const url = new URL(request.url);
  const orgIdRaw = (url.searchParams.get("orgId") ?? "").trim() || session.activeOrgId || "";
  if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) {
    return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });
  }

  await connectMongo();

  // Personal orgs are single-user; invites are not supported.
  const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgIdRaw), isDeleted: { $ne: true } })
    .select({ type: 1 })
    .lean();
  const orgType = org ? String((org as { type?: unknown }).type ?? "") : "";
  if (orgType !== "team") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const membership = await OrgMembershipModel.findOne({
    orgId: new Types.ObjectId(orgIdRaw),
    userId: new Types.ObjectId(session.userId),
    isDeleted: { $ne: true },
  })
    .select({ role: 1 })
    .lean();
  const userRole = membership ? String((membership as { role?: unknown }).role ?? "") : "";
  const canInvite = userRole === "owner" || userRole === "admin";
  if (!canInvite) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const invites = await OrgInviteModel.find({
    orgId: new Types.ObjectId(orgIdRaw),
    isRevoked: { $ne: true },
  })
    .select({
      _id: 1,
      role: 1,
      expiresAt: 1,
      redeemedAt: 1,
      redeemedByUserId: 1,
      createdDate: 1,
      recipientEmail: 1,
      tokenEnc: 1,
      tokenEncIv: 1,
      tokenEncTag: 1,
    })
    .sort({ createdDate: -1 })
    .limit(25)
    .lean();

  const redeemedUserIds = Array.from(
    new Set(
      invites
        .map((inv) => (inv as { redeemedByUserId?: unknown }).redeemedByUserId)
        .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId),
    ),
  );
  const redeemedUsers = redeemedUserIds.length
    ? await UserModel.find({ _id: { $in: redeemedUserIds } }).select({ email: 1, name: 1 }).lean()
    : [];
  const redeemedById = new Map(redeemedUsers.map((u) => [String(u._id), u]));

  const origin = originFromRequest(request);
  const out = invites.map((inv) => {
    const token = decryptInviteToken({
      enc: (inv as unknown as { tokenEnc?: unknown }).tokenEnc,
      iv: (inv as unknown as { tokenEncIv?: unknown }).tokenEncIv,
      tag: (inv as unknown as { tokenEncTag?: unknown }).tokenEncTag,
    });
    const inviteUrl =
      token && origin ? `${origin}/org/join/${encodeURIComponent(token)}` : token ? `/org/join/${encodeURIComponent(token)}` : null;

    const redeemedByUserId =
      (inv as unknown as { redeemedByUserId?: unknown }).redeemedByUserId instanceof Types.ObjectId
        ? String((inv as unknown as { redeemedByUserId: Types.ObjectId }).redeemedByUserId)
        : null;
    const redeemedUser = redeemedByUserId ? (redeemedById.get(redeemedByUserId) ?? null) : null;

    return {
      id: String((inv as unknown as { _id: Types.ObjectId })._id),
      role: String((inv as unknown as { role?: unknown }).role ?? "member"),
      email:
        typeof (inv as unknown as { recipientEmail?: unknown }).recipientEmail === "string"
          ? ((inv as unknown as { recipientEmail: string }).recipientEmail as string)
          : null,
      expiresAt:
        (inv as unknown as { expiresAt?: unknown }).expiresAt instanceof Date
          ? ((inv as unknown as { expiresAt: Date }).expiresAt.toISOString() as string)
          : null,
      redeemedAt:
        (inv as unknown as { redeemedAt?: unknown }).redeemedAt instanceof Date
          ? ((inv as unknown as { redeemedAt: Date }).redeemedAt.toISOString() as string)
          : null,
      redeemedBy:
        redeemedByUserId && redeemedUser
          ? {
              userId: redeemedByUserId,
              email: typeof (redeemedUser as { email?: unknown }).email === "string" ? (redeemedUser as { email: string }).email : null,
              name: typeof (redeemedUser as { name?: unknown }).name === "string" ? (redeemedUser as { name: string }).name : null,
            }
          : null,
      createdDate:
        (inv as unknown as { createdDate?: unknown }).createdDate instanceof Date
          ? ((inv as unknown as { createdDate: Date }).createdDate.toISOString() as string)
          : null,
      inviteUrl,
    };
  });

  return NextResponse.json({ ok: true, invites: out });
}

export async function POST(request: Request) {
  const session = await tryResolveAuthUserId(request);
  if (!session?.userId) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<{
    orgId: string;
    role: "admin" | "member" | "viewer";
    ttlDays: number;
  }>;

  const orgIdRaw = typeof body.orgId === "string" ? body.orgId.trim() : session.activeOrgId || "";
  const role = body.role === "admin" || body.role === "viewer" ? body.role : "member";
  const ttlDaysRaw = typeof body.ttlDays === "number" ? body.ttlDays : 7;
  const ttlDays = Math.max(1, Math.min(30, Math.floor(ttlDaysRaw)));

  if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) {
    return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });
  }

  await connectMongo();

  // Personal orgs are single-user; invites are not supported.
  const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgIdRaw), isDeleted: { $ne: true } })
    .select({ type: 1 })
    .lean();
  const orgType = org ? String((org as { type?: unknown }).type ?? "") : "";
  if (orgType !== "team") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const membership = await OrgMembershipModel.findOne({
    orgId: new Types.ObjectId(orgIdRaw),
    userId: new Types.ObjectId(session.userId),
    isDeleted: { $ne: true },
  })
    .select({ role: 1 })
    .lean();
  const userRole = membership ? String((membership as { role?: unknown }).role ?? "") : "";
  const canInvite = userRole === "owner" || userRole === "admin";
  if (!canInvite) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const token = crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256Hex(token);
  const tokenEncrypted = encryptInviteToken(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const created = await OrgInviteModel.create({
    orgId: new Types.ObjectId(orgIdRaw),
    createdByUserId: new Types.ObjectId(session.userId),
    tokenHash,
    tokenEnc: tokenEncrypted.enc,
    tokenEncIv: tokenEncrypted.iv,
    tokenEncTag: tokenEncrypted.tag,
    role,
    expiresAt,
    isRevoked: false,
    redeemedByUserId: null,
    redeemedAt: null,
  });
  const doc = Array.isArray(created) ? created[0] : created;
  const inviteId = String((doc as unknown as { _id: Types.ObjectId })._id);

  const origin = originFromRequest(request);
  const inviteUrl = origin ? `${origin}/org/join/${encodeURIComponent(token)}` : `/org/join/${encodeURIComponent(token)}`;

  return NextResponse.json({
    ok: true,
    invite: { id: inviteId, role, expiresAt: expiresAt.toISOString(), inviteUrl },
  });
}


