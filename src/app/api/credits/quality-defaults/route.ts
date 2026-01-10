/**
 * API route for `/api/credits/quality-defaults`.
 *
 * Workspace-level default quality tiers for AI actions.
 * Customer-facing and credits-first: never returns vendor model names or token telemetry.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor, tryResolveAuthUserId } from "@/lib/gating/actor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Tier = "basic" | "standard" | "advanced";

// Short-lived in-memory cache to keep the dashboard Limits tab snappy.
// Safe because these defaults rarely change and the UI refreshes after saves.
const QUALITY_DEFAULTS_CACHE_TTL_MS = 10_000;
let qualityDefaultsCache: Map<string, { at: number; payload: any }> | null = null;

function parseTier(v: unknown): Tier | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "basic") return "basic";
  if (s === "standard") return "standard";
  if (s === "advanced") return "advanced";
  return null;
}

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

async function resolveUserAndOrgForWorkspaceRoute(request: Request): Promise<{ ok: true; userId: Types.ObjectId; orgId: Types.ObjectId } | { ok: false; status: number; error: string }> {
  const session = await tryResolveAuthUserId(request);
  if (!session?.userId) return { ok: false, status: 401, error: "Unauthorized" };
  if (!Types.ObjectId.isValid(session.userId)) return { ok: false, status: 400, error: "Invalid user" };

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieOrgIdRaw = readCookie(cookieHeader, ACTIVE_ORG_COOKIE);
  const cookieOrgId = typeof cookieOrgIdRaw === "string" ? cookieOrgIdRaw.trim() : "";
  const claimOrgId = typeof session.activeOrgId === "string" ? session.activeOrgId.trim() : "";

  const orgIdStr = cookieOrgId && Types.ObjectId.isValid(cookieOrgId) ? cookieOrgId : claimOrgId;
  if (orgIdStr && Types.ObjectId.isValid(orgIdStr)) {
    return { ok: true, userId: new Types.ObjectId(session.userId), orgId: new Types.ObjectId(orgIdStr) };
  }

  // Fallback: full actor resolution (ensures org context exists).
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return { ok: false, status: 401, error: "Unauthorized" };
  if (!Types.ObjectId.isValid(actor.userId)) return { ok: false, status: 400, error: "Invalid user" };
  if (!Types.ObjectId.isValid(actor.orgId)) return { ok: false, status: 400, error: "Invalid org" };
  return { ok: true, userId: new Types.ObjectId(actor.userId), orgId: new Types.ObjectId(actor.orgId) };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    try {
      const ctx = await resolveUserAndOrgForWorkspaceRoute(request);
      if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

      qualityDefaultsCache = qualityDefaultsCache ?? new Map();
      const cacheKey = `${String(ctx.orgId)}:${String(ctx.userId)}`;
      const cached = qualityDefaultsCache.get(cacheKey);
      if (cached && Date.now() - cached.at < QUALITY_DEFAULTS_CACHE_TTL_MS) {
        return NextResponse.json(cached.payload, { headers: { "cache-control": "no-store" } });
      }

      await connectMongo();
      const [membership, bal] = await Promise.all([
        OrgMembershipModel.findOne({ orgId: ctx.orgId, userId: ctx.userId, isDeleted: { $ne: true } }).select({ role: 1 }).lean(),
        WorkspaceCreditBalanceModel.findOne({ workspaceId: ctx.orgId }).select({ defaultReviewQualityTier: 1, defaultHistoryQualityTier: 1 }).lean(),
      ]);
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      const review = parseTier((bal as any)?.defaultReviewQualityTier) ?? "standard";
      const history = parseTier((bal as any)?.defaultHistoryQualityTier) ?? "standard";

      const payload = { ok: true, review, history };
      qualityDefaultsCache.set(cacheKey, { at: Date.now(), payload });
      if (qualityDefaultsCache.size > 200) {
        // Best-effort eviction: drop an arbitrary entry (avoid full scan).
        const first = qualityDefaultsCache.keys().next();
        if (!first.done) qualityDefaultsCache.delete(first.value);
      }

      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load defaults";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    try {
      const ctx = await resolveUserAndOrgForWorkspaceRoute(request);
      if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

      await connectMongo();
      const membership = await OrgMembershipModel.findOne({ orgId: ctx.orgId, userId: ctx.userId, isDeleted: { $ne: true } }).select({ role: 1 }).lean();
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      const body = (await request.json().catch(() => null)) as any;
      const review = parseTier(body?.reviewQualityTier);
      const history = parseTier(body?.historyQualityTier);
      if (!review || !history) {
        return NextResponse.json({ error: "reviewQualityTier and historyQualityTier must be: standard | advanced" }, { status: 400 });
      }

      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: ctx.orgId },
        { $set: { defaultReviewQualityTier: review, defaultHistoryQualityTier: history } },
        { upsert: true },
      );

      // Best-effort: invalidate cached payloads for this org (per-user cache keys).
      try {
        if (qualityDefaultsCache) {
          const prefix = `${String(ctx.orgId)}:`;
          for (const k of Array.from(qualityDefaultsCache.keys())) {
            if (k.startsWith(prefix)) qualityDefaultsCache.delete(k);
          }
        }
      } catch {
        // ignore
      }

      return NextResponse.json({ ok: true, review, history }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save defaults";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


