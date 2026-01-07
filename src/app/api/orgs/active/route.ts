/**
 * API route for `/api/orgs/active`.
 *
 * Sets/gets the active org (workspace) context for the current signed-in user.
 *
 * Why a dedicated cookie:
 * - NextAuth session updates are not always reliable for persisting custom claims.
 * - A small, membership-validated httpOnly cookie is deterministic for route handlers.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { debugError, debugLog } from "@/lib/debug";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const ACTIVE_ORG_COOKIE = "ld_active_org";

export async function GET(request: Request) {
  try {
    debugLog(2, "[api/orgs/active] GET");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    return NextResponse.json({ activeOrgId: actor.orgId }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/orgs/active] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    debugLog(1, "[api/orgs/active] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{ orgId: string | null }>;
    const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
    if (!orgId || !Types.ObjectId.isValid(orgId)) {
      return NextResponse.json({ error: "Invalid orgId" }, { status: 400 });
    }

    await connectMongo();
    const ok = await OrgMembershipModel.exists({
      orgId: new Types.ObjectId(orgId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Persist active org in the user record as the source of truth.
    // This avoids relying on cookie persistence edge cases in some environments.
    await UserModel.updateOne(
      { _id: new Types.ObjectId(actor.userId) },
      { $set: { "metadata.activeOrgId": orgId, lastLoginAt: new Date() } },
    );

    const res = NextResponse.json({ ok: true, activeOrgId: orgId }, { headers: { "cache-control": "no-store" } });
    res.cookies.set(ACTIVE_ORG_COOKIE, orgId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/orgs/active] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


