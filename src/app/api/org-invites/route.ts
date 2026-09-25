/**
 * API route for `/api/org-invites`.
 *
 * - GET: list this org's live (non-revoked) invites, newest first (owner/admin only).
 * - POST: create a new org invite link (owner/admin only).
 *
 * GET response shape:
 *   { ok, invites: [...], counts: { all, notUsed, used, expired }, page: { limit, offset, hasMore } }
 * `invites` is unchanged from before pagination existed; `counts` and `page` are additive. The
 * counts are computed over the whole workspace, not over the page — see the comment on the handler.
 *
 * Notes:
 * - Invite tokens are returned only once (plaintext is never stored).
 * - Invite redemption is handled by `/api/org-invites/claim`.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { OrgInviteModel } from "@/lib/models/OrgInvite";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { OrgModel } from "@/lib/models/Org";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { recordActivity } from "@/lib/activity/log";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";

export const runtime = "nodejs";

const ENC_IV_BYTES = 12;

/** Rows per page of GET /api/org-invites when the caller names no `limit`. */
const INVITE_PAGE_DEFAULT = 25;
/** Ceiling on `limit`, so one request cannot ask us to decrypt an unbounded number of tokens. */
const INVITE_PAGE_MAX = 100;

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
  return withMongoRequestLogging(request, async () => {
    const session = await tryResolveAuthUserId(request);
    if (!session?.userId) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const url = new URL(request.url);
    const orgIdRaw = (url.searchParams.get("orgId") ?? "").trim() || session.activeOrgId || "";
    if (!orgIdRaw || !Types.ObjectId.isValid(orgIdRaw)) {
      return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });
    }

    await connectMongo();

    // Any workspace can have members; the plan decides how many, below. The type on the row is
    // history, not a rule (2026-09-25).
    const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgIdRaw), isDeleted: { $ne: true } })
      .select({ _id: 1 })
      .lean();
    if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

    // Paging. This list used to be a hard `.limit(25)` with no way to ask for more and no total,
    // and the Teams tab counted its filter tabs ("Not used (3)") off exactly that truncated array —
    // so a workspace past 25 invites was shown confident numbers that were wrong, and its oldest
    // still-claimable links appeared under no filter at all, not even "All".
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(INVITE_PAGE_MAX, Math.floor(limitRaw))
      : INVITE_PAGE_DEFAULT;
    const offsetRaw = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

    // `isRevoked: false`, not `{ $ne: true }`: every document has the field (the schema has
    // defaulted it to false since it was written), and only the equality form lets the planner use
    // the { orgId, createdDate } partial index — see the comment on it in models/OrgInvite.ts.
    const scope = { orgId: new Types.ObjectId(orgIdRaw), isRevoked: false } as const;

    const invites = await OrgInviteModel.find(scope)
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
      .skip(offset)
      .limit(limit)
      .lean();

    // Counts over the whole workspace, so the tab labels stop being a description of the page.
    // The buckets mirror what the client derived row by row: an invite is "used" once it has a
    // `redeemedAt`, "expired" when it has none and its `expiresAt` has passed, "not used" otherwise.
    // `expiresAt` is required by the schema, so there is no third state to account for here.
    const countedAt = new Date();
    const [countAll, countUsed, countExpired] = await Promise.all([
      OrgInviteModel.countDocuments(scope),
      OrgInviteModel.countDocuments({ ...scope, redeemedAt: { $ne: null } }),
      OrgInviteModel.countDocuments({ ...scope, redeemedAt: null, expiresAt: { $lte: countedAt } }),
    ]);
    const counts = {
      all: countAll,
      used: countUsed,
      expired: countExpired,
      notUsed: Math.max(0, countAll - countUsed - countExpired),
    };

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

    return NextResponse.json({
      ok: true,
      invites: out,
      counts,
      // `hasMore` is derived from the total rather than an extra row, since we have the total anyway.
      page: { limit, offset, hasMore: offset + out.length < countAll },
    });
  });
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

  // Any workspace can have members; the plan decides how many, below.
  const org = await OrgModel.findOne({ _id: new Types.ObjectId(orgIdRaw), isDeleted: { $ne: true } })
    .select({ _id: 1 })
    .lean();
  if (!org) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  // Plan limits: Free workspaces cannot add collaborators (the invite would add a member).
  // `role` matters: a viewer takes no seat, so inviting one is never a plan decision.
  const limitCheck = await checkLimit(orgIdRaw, "collaborators", { role });
  if (!limitCheck.ok) return planLimitResponse(limitCheck, { orgId: orgIdRaw, userId: session.userId, request });

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

  // Who was let in, and by whom. An invite link is the moment the workspace's door opens, and
  // before this nothing recorded it: the Members page shows who is here now, never who opened it or
  // when. A link invite names no recipient, so the sentence says only that one was created.
  void recordActivity({
    orgId: orgIdRaw,
    userId: session.userId,
    actorKind: "user",
    type: "member.invited",
    meta: { role, inviteId, via: "link", expiresAt: expiresAt.toISOString() },
    request,
  });

  const origin = originFromRequest(request);
  const inviteUrl = origin ? `${origin}/org/join/${encodeURIComponent(token)}` : `/org/join/${encodeURIComponent(token)}`;

  return NextResponse.json({
    ok: true,
    invite: { id: inviteId, role, expiresAt: expiresAt.toISOString(), inviteUrl },
  });
}


