/**
 * API route for `/api/orgs/active/notification-preferences`.
 *
 * Read/update the current user's notification preferences for the active org.
 * Auth required (internal workspace members only).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Mode = "off" | "daily" | "immediate";

function isMode(v: unknown): v is Mode {
  // Accept legacy/canonical `immediate` and tolerate `immediately` as an alias from clients.
  return v === "off" || v === "daily" || v === "immediate" || v === "immediately";
}

function normalizeMode(v: Mode | "immediately"): Mode {
  return v === "immediately" ? "immediate" : v;
}

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  await connectMongo();
  const membership = await OrgMembershipModel.findOne({
    orgId: new Types.ObjectId(actor.orgId),
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
  })
    .select({ docUpdateEmailMode: 1, repoLinkRequestEmailMode: 1, docUpdateDigestTimezone: 1, docUpdateDigestTimeLocal: 1 })
    .lean();
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(
    {
      ok: true,
      orgId: actor.orgId,
      userId: actor.userId,
      docUpdateEmailMode:
        typeof (membership as any).docUpdateEmailMode === "string" ? (membership as any).docUpdateEmailMode : "daily",
      repoLinkRequestEmailMode:
        typeof (membership as any).repoLinkRequestEmailMode === "string"
          ? (membership as any).repoLinkRequestEmailMode
          : "daily",
      docUpdateDigestTimezone:
        typeof (membership as any).docUpdateDigestTimezone === "string" ? (membership as any).docUpdateDigestTimezone : null,
      docUpdateDigestTimeLocal:
        typeof (membership as any).docUpdateDigestTimeLocal === "string" ? (membership as any).docUpdateDigestTimeLocal : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Partial<{
    docUpdateEmailMode: Mode;
    repoLinkRequestEmailMode: Mode;
  }>;
  const set: Record<string, unknown> = {};
  if (typeof body.docUpdateEmailMode !== "undefined") {
    if (!isMode(body.docUpdateEmailMode)) return NextResponse.json({ error: "Invalid docUpdateEmailMode" }, { status: 400 });
    set.docUpdateEmailMode = normalizeMode(body.docUpdateEmailMode);
  }
  if (typeof body.repoLinkRequestEmailMode !== "undefined") {
    if (!isMode(body.repoLinkRequestEmailMode)) {
      return NextResponse.json({ error: "Invalid repoLinkRequestEmailMode" }, { status: 400 });
    }
    set.repoLinkRequestEmailMode = normalizeMode(body.repoLinkRequestEmailMode);
  }
  if (!Object.keys(set).length) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  await connectMongo();
  const res = await OrgMembershipModel.updateOne(
    {
      orgId: new Types.ObjectId(actor.orgId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    },
    { $set: { ...set, updatedDate: new Date() } },
  );
  if (!res.matchedCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...set }, { headers: { "cache-control": "no-store" } });
}


