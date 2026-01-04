/**
 * API route for `/api/docs/:docId/history/:version/recipients`.
 *
 * Returns (org members) + whether each has "opened" the given doc version (any page timing).
 * Auth required; any org member with access to the doc can call this.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, applyTempUserHeaders } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";

export const runtime = "nodejs";

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

export async function GET(request: Request, ctx: { params: Promise<{ docId: string; version: string }> }) {
  const actor = await resolveActor(request);
  try {
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    const { docId, version: versionRaw } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }
    const version = asPositiveInt(versionRaw);
    if (!version) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid version" }, { status: 400 }), actor);
    }

    await connectMongo();

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback).
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docExists = await DocModel.exists({
      ...(allowLegacyByUserId
        ? {
            $or: [
              { _id: docObjectId, orgId, isDeleted: { $ne: true } },
              {
                _id: docObjectId,
                userId: legacyUserId,
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: docObjectId, orgId, isDeleted: { $ne: true } }),
    });
    if (!docExists) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    // Members (all org members for now).
    const memberships = await OrgMembershipModel.find({ orgId, isDeleted: { $ne: true } })
      .select({ userId: 1 })
      .lean();
    const userIds = memberships
      .map((m) => (m as any).userId)
      .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
    const users = await UserModel.find({ _id: { $in: userIds }, isActive: { $ne: false } })
      .select({ _id: 1, name: 1, email: 1 })
      .lean();

    // Opened map: any timing record exists for doc+version+user.
    const openedAgg = (await DocPageTimingModel.aggregate([
      { $match: { orgId, docId: docObjectId, version } },
      { $group: { _id: "$viewerUserId", openedAt: { $min: "$createdDate" } } },
    ])) as Array<{ _id: Types.ObjectId; openedAt?: Date }>;
    const openedSet = new Set(openedAgg.map((x) => String(x._id)));

    const items = users
      .map((u) => ({
        userId: String(u._id),
        name: typeof (u as any).name === "string" ? (u as any).name : null,
        email: typeof (u as any).email === "string" ? (u as any).email : null,
        opened: openedSet.has(String(u._id)),
      }))
      .sort((a, b) => {
        // Opened first, then name/email.
        if (a.opened !== b.opened) return a.opened ? -1 : 1;
        const an = (a.name ?? a.email ?? "").toLowerCase();
        const bn = (b.name ?? b.email ?? "").toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return a.userId < b.userId ? -1 : 1;
      });

    return applyTempUserHeaders(
      NextResponse.json({ ok: true, docId, version, recipients: items }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}


