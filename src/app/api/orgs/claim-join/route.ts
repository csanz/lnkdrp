/**
 * API route for `/api/orgs/claim-join`.
 *
 * Completes the "create org → re-auth → join as another user" flow:
 * - Reads a short-lived httpOnly cookie containing a one-time join secret
 * - Validates the secret against the org record
 * - Adds the currently signed-in user as a member of that org
 * - Clears the join secret + cookie (single use)
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { debugError, debugLog } from "@/lib/debug";
import { resolveActor } from "@/lib/gating/actor";

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



