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
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { OrgModel } from "@/lib/models/Org";
import { resolveActor } from "@/lib/gating/actor";
import { sendOrgInviteEmail } from "@/lib/email/sendOrgInviteEmail";
import { recordActivity } from "@/lib/activity/log";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";

export const runtime = "nodejs";

/** Invite emails per workspace per hour. Generous for onboarding a team, useless as a mailer. */
const INVITE_EMAIL_ORG_LIMIT = 20;
/** The same recipient, from anywhere, per hour. */
const INVITE_EMAIL_RECIPIENT_LIMIT = 3;
const INVITE_EMAIL_WINDOW_MS = 60 * 60 * 1000;

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
  // Identity-grade: a key may not invite someone to a workspace — see forbidApiKey.
  const keyRefusal = forbidApiKey(actor, "invite someone to a workspace");
  if (keyRefusal) return keyRefusal;
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

  /**
   * This route sends mail from our verified domain to any address the caller names, with the
   * workspace's own name in the subject line. Unlimited, that is a spam cannon pointed at our
   * sending reputation: one compromised or careless member could mail thousands of strangers, and
   * every bounce lands on the domain every share-link notification also goes out from.
   *
   * Two keys, the shape `/api/share/:shareId/download-requests` already uses: one per workspace so
   * a single workspace cannot burn the domain, and one per recipient so the same person cannot be
   * mailed repeatedly from different workspaces.
   */
  const rlOrg = await rateLimit({
    key: `orginvite:org:${orgIdRaw}`,
    limit: INVITE_EMAIL_ORG_LIMIT,
    windowMs: INVITE_EMAIL_WINDOW_MS,
  });
  if (!rlOrg.ok) return rateLimitedResponse(rlOrg);
  const rlEmail = await rateLimit({
    key: `orginvite:to:${crypto.createHash("sha256").update(email).digest("hex")}`,
    limit: INVITE_EMAIL_RECIPIENT_LIMIT,
    windowMs: INVITE_EMAIL_WINDOW_MS,
  });
  if (!rlEmail.ok) return rateLimitedResponse(rlEmail);

  await connectMongo();

  // Personal orgs are single-user; invites are not supported.
  const orgTypeCheck = await OrgModel.findOne({ _id: new Types.ObjectId(orgIdRaw), isDeleted: { $ne: true } })
    .select({ type: 1 })
    .lean();
  const orgType = orgTypeCheck ? String((orgTypeCheck as { type?: unknown }).type ?? "") : "";
  if (orgType !== "team") return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  // Plan limits: an emailed invite would add a member; Free workspaces have no collaborator seats.
  const limitCheck = await checkLimit(orgIdRaw, "collaborators");
  if (!limitCheck.ok) return planLimitResponse(limitCheck);

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
    invitedByEmail: null,
    // For the workspace's avatar in the header: the invitee knows this name, not ours.
    orgId: orgIdRaw,
  });

  // Logged after the send, not before: an invite the mail provider refused is not an invitation,
  // and a feed that says otherwise sends the sender looking for a reply that was never asked for.
  void recordActivity({
    orgId: orgIdRaw,
    userId: actor.userId,
    actorKind: "user",
    type: "member.invited",
    meta: { role, inviteId, via: "email", email, expiresAt: expiresAt.toISOString() },
    request,
  });

  return NextResponse.json({
    ok: true,
    invite: { id: inviteId, role, expiresAt: expiresAt.toISOString(), inviteUrl, email },
  });
}


