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
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { activeOrgChanged } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    debugLog(2, "[api/orgs/active] GET");
    // Hot path: this endpoint is hit frequently by the dashboard Workspace tab.
    // Prefer the fast resolver (cookie/JWT + single membership check) and fall back to the full
    // resolver only when org context can't be determined.
    const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
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
    /**
     * Keys do document work, not identity work.
     *
     * This writes `User.metadata.activeOrgId`, which `activeOrgCandidateOrder` ranks *above* the
     * JWT claim — so it decides where that person's next document lands on any browser without an
     * `ld_active_org` cookie. An `lnk_` key resolves to a `kind: "user"` actor carrying its
     * issuer's memberships, so a key scoped to one workspace could move its owner's stored
     * workspace to another, silently and with no user action. The next upload from a second laptop
     * would then create the document — and a live public share link — somewhere the owner never
     * chose, visible to that workspace's other members.
     *
     * `/org/switch` already guards the identical write with `Sec-Fetch-Site`; this is the same
     * write reachable over the API.
     */
    const keyForbidden = forbidApiKey(actor, "change the active workspace");
    if (keyForbidden) return keyForbidden;

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
    // The resolvers cache this value for a minute, so the switch has to say it moved. In this
    // browser the cookie set alongside it wins anyway; on the person's *other* device the metadata
    // is the only signal, and without this the switch would look like it had not taken.
    activeOrgChanged(actor.userId);

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


