/**
 * API route for `/api/credits/quality-defaults`.
 *
 * Workspace-level default quality tiers for AI actions.
 * Customer-facing and credits-first: never returns vendor model names or token telemetry.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Tier = "basic" | "standard" | "advanced";

function parseTier(v: unknown): Tier | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "basic") return "basic";
  if (s === "standard") return "standard";
  if (s === "advanced") return "advanced";
  return null;
}

async function requireOwnerOrAdmin(actor: { userId: string; orgId: string }) {
  if (!Types.ObjectId.isValid(actor.userId)) return { ok: false as const, status: 400, error: "Invalid user" };
  if (!Types.ObjectId.isValid(actor.orgId)) return { ok: false as const, status: 400, error: "Invalid org" };
  const orgId = new Types.ObjectId(actor.orgId);
  const userId = new Types.ObjectId(actor.userId);
  const membership = await OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } })
    .select({ role: 1 })
    .lean();
  const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
  if (role !== "owner" && role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };
  return { ok: true as const, orgId };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await connectMongo();
      const perm = await requireOwnerOrAdmin({ userId: actor.userId, orgId: actor.orgId });
      if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: perm.status });

      const bal = await WorkspaceCreditBalanceModel.findOne({ workspaceId: perm.orgId })
        .select({ defaultReviewQualityTier: 1, defaultHistoryQualityTier: 1 })
        .lean();

      const review = parseTier((bal as any)?.defaultReviewQualityTier) ?? "standard";
      const history = parseTier((bal as any)?.defaultHistoryQualityTier) ?? "standard";

      return NextResponse.json({ ok: true, review, history }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load defaults";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      await connectMongo();
      const perm = await requireOwnerOrAdmin({ userId: actor.userId, orgId: actor.orgId });
      if (!perm.ok) return NextResponse.json({ error: perm.error }, { status: perm.status });

      const body = (await request.json().catch(() => null)) as any;
      const review = parseTier(body?.reviewQualityTier);
      const history = parseTier(body?.historyQualityTier);
      if (!review || !history) {
        return NextResponse.json({ error: "reviewQualityTier and historyQualityTier must be: standard | advanced" }, { status: 400 });
      }

      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: perm.orgId },
        { $set: { defaultReviewQualityTier: review, defaultHistoryQualityTier: history } },
        { upsert: true },
      );

      return NextResponse.json({ ok: true, review, history }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save defaults";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


