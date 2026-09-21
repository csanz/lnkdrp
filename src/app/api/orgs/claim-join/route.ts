/**
 * API route for `/api/orgs/claim-join`.
 *
 * Completes the "create org → re-auth → join as another user" flow:
 * - Reads a short-lived httpOnly cookie containing a one-time join secret
 * - Validates the secret against the org record
 * - Adds the currently signed-in user as a member of that org
 * - Clears the join secret + cookie (single use)
 *
 * Plan limits: joining adds a collaborator, so a user who is not already a member of a Free team
 * org gets a 402 (`code: "plan_limit"`) and the cookie is cleared (the secret is short-lived anyway).
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { debugError, debugLog } from "@/lib/debug";
import { recordActivity } from "@/lib/activity/log";
import { checkLimit, planLimitResponse } from "@/lib/billing/planLimits";
import { membershipChanged, resolveActor } from "@/lib/gating/actor";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";

const JOIN_COOKIE = "ld_org_join";

function readCookie(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(";").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function POST(request: Request) {
  try {
    debugLog(2, "[api/orgs/claim-join] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const cookieHeader = request.headers.get("cookie") ?? "";
    const raw = readCookie(cookieHeader, JOIN_COOKIE);
    if (!raw) return NextResponse.json({ ok: true, claimed: false });

    const [orgIdRaw, secretRaw] = raw.split(".", 2);
    const orgId = (orgIdRaw ?? "").trim();
    const secret = (secretRaw ?? "").trim();
    if (!Types.ObjectId.isValid(orgId) || !secret) {
      const res = NextResponse.json({ ok: true, claimed: false });
      res.cookies.set(JOIN_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }

    await connectMongo();
    const orgObjectId = new Types.ObjectId(orgId);
    const org = await OrgModel.findOne({ _id: orgObjectId, isDeleted: { $ne: true } })
      .select({ _id: 1, joinSecretHash: 1, joinSecretExpiresAt: 1 })
      .lean();

    const expiresAt = (org as unknown as { joinSecretExpiresAt?: unknown }).joinSecretExpiresAt;
    const hash = (org as unknown as { joinSecretHash?: unknown }).joinSecretHash;
    const now = Date.now();
    const expired = !(expiresAt instanceof Date) || expiresAt.getTime() <= now;
    const expectedHash = typeof hash === "string" && hash ? hash : "";
    const providedHash = sha256Hex(secret);
    const ok = Boolean(org && expectedHash && !expired && expectedHash === providedHash);

    if (!ok) {
      const res = NextResponse.json({ ok: true, claimed: false });
      res.cookies.set(JOIN_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }

    // Add membership for the currently authenticated user.
    const userId = new Types.ObjectId(actor.userId);

    // Collaborator gate: only a brand-new (or previously removed) member counts against the cap.
    const alreadyMember = await OrgMembershipModel.exists({ orgId: orgObjectId, userId, isDeleted: { $ne: true } });
    if (!alreadyMember) {
      const limitCheck = await checkLimit(orgObjectId, "collaborators");
      if (!limitCheck.ok) {
        void recordActivity({
          orgId: orgObjectId,
          userId: actor.userId,
          actorKind: actor.kind,
          type: "plan.limit_reached",
          meta: { limit: limitCheck.limit, used: limitCheck.used, max: limitCheck.max },
          request,
        });
        const res = planLimitResponse(limitCheck);
        res.cookies.set(JOIN_COOKIE, "", { path: "/", maxAge: 0 });
        return res;
      }
    }

    await OrgMembershipModel.updateOne(
      { orgId: orgObjectId, userId },
      {
        $setOnInsert: {
          orgId: orgObjectId,
          userId,
          role: "member",
          createdDate: new Date(),
        },
        $set: { isDeleted: false, updatedDate: new Date() },
      },
      { upsert: true },
    );

    membershipChanged({ orgId: orgObjectId, userId: actor.userId });

    // Same event as redeeming an invite, different door: this is the "created the workspace, then
    // signed in as the account that will use it" path. `via` says which.
    if (!alreadyMember) {
      const joined = (await UserModel.findById(userId).select({ name: 1, email: 1 }).lean()) as
        | { name?: string | null; email?: string | null }
        | null;
      void recordActivity({
        orgId: orgObjectId,
        userId: actor.userId,
        actorKind: "user",
        type: "member.joined",
        meta: {
          role: "member",
          via: "join_secret",
          name: joined?.name?.trim() || null,
          email: joined?.email?.trim().toLowerCase() || null,
        },
        request,
      });
    }

    // Single-use: clear join secret on org.
    await OrgModel.updateOne(
      { _id: orgObjectId },
      { $set: { joinSecretHash: null, joinSecretExpiresAt: null } },
    );

    const res = NextResponse.json({ ok: true, claimed: true, orgId });
    res.cookies.set(JOIN_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/orgs/claim-join] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}



