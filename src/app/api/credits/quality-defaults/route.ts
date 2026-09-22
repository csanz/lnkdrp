/**
 * API route for `/api/credits/quality-defaults`.
 *
 * Workspace-level default quality tiers for AI actions.
 * Customer-facing and credits-first: never returns vendor model names or token telemetry.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor, tryResolveUserActorFast, type Actor } from "@/lib/gating/actor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { defaultBalanceForWorkspace } from "@/lib/credits/creditService";
import { parseQualityTier as parseTier, resolveHistoryQualityTier } from "@/lib/credits/qualityDefaults";
import { parseAutomationFlag, resolveAiAutomation } from "@/lib/credits/aiAutomation";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short-lived in-memory cache to keep the dashboard Limits tab snappy.
// Safe because these defaults rarely change and the UI refreshes after saves.
const QUALITY_DEFAULTS_CACHE_TTL_MS = 10_000;
let qualityDefaultsCache: Map<string, { at: number; payload: any }> | null = null;

async function resolveUserAndOrgForWorkspaceRoute(request: Request): Promise<{ ok: true; userId: Types.ObjectId; orgId: Types.ObjectId; actor: Actor } | { ok: false; status: number; error: string }> {
  // Membership-validated fast path (cookie / JWT claim + one cached membership check), then the full
  // resolver. Never trust the cookie alone: a stale one pointing at another workspace used to 403 here.
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  if (actor.kind !== "user") return { ok: false, status: 401, error: "Unauthorized" };
  if (!Types.ObjectId.isValid(actor.userId)) return { ok: false, status: 400, error: "Invalid user" };
  if (!Types.ObjectId.isValid(actor.orgId)) return { ok: false, status: 400, error: "Invalid org" };
  // The actor travels with the ids: a caller that needs to know *how* this request authenticated —
  // a browser session or an `lnk_` key — cannot ask once the helper has reduced it to two ids.
  return { ok: true, userId: new Types.ObjectId(actor.userId), orgId: new Types.ObjectId(actor.orgId), actor };
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
      const [membership, bal, plan] = await Promise.all([
        OrgMembershipModel.findOne({ orgId: ctx.orgId, userId: ctx.userId, isDeleted: { $ne: true } }).select({ role: 1 }).lean(),
        WorkspaceCreditBalanceModel.findOne({ workspaceId: ctx.orgId }).select({ defaultReviewQualityTier: 1, defaultHistoryQualityTier: 1, autoSummaryEnabled: 1, autoCompareEnabled: 1 }).lean(),
        getWorkspacePlan(ctx.orgId),
      ]);
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      const review = parseTier((bal as any)?.defaultReviewQualityTier) ?? "standard";
      // Compare tier is plan-aware when unset: Basic on Free, Standard on Pro. A stored value wins.
      const history = resolveHistoryQualityTier((bal as any)?.defaultHistoryQualityTier, plan);

      // The two automatic runs. Absent fields read as on; see `aiAutomation.ts`.
      const automation = resolveAiAutomation(bal as any);

      const payload = { ok: true, review, history, autoSummary: automation.summary, autoCompare: automation.compare };
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

      // The role was checked above, but an `lnk_` key resolves to a `kind: "user"` actor with its
      // issuer's role — so an agent could switch a workspace's automatic summaries off, or move
      // every compare to Advanced, from a key that was scoped for uploading documents.
      const keyForbidden = forbidApiKey(ctx.actor, "change this workspace's AI settings");
      if (keyForbidden) return keyForbidden;

      const body = (await request.json().catch(() => null)) as any;
      const review = parseTier(body?.reviewQualityTier);
      const history = parseTier(body?.historyQualityTier);
      if (!review || !history) {
        return NextResponse.json({ error: "reviewQualityTier and historyQualityTier must be: basic | standard | advanced" }, { status: 400 });
      }
      // Optional, and only a real boolean counts: a caller that omits these (the dashboard tier
      // card, which predates them) must not be read as switching both runs off.
      const autoSummary = parseAutomationFlag(body?.autoSummary);
      const autoCompare = parseAutomationFlag(body?.autoCompare);

      // Upsert: when this is the first write to the balance row, seed it the same way the reserve
      // and snapshot paths do so the Free starter grant / daily cap are not silently skipped.
      const seed = await defaultBalanceForWorkspace(ctx.orgId);
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: ctx.orgId },
        {
          $set: {
            defaultReviewQualityTier: review,
            defaultHistoryQualityTier: history,
            ...(autoSummary === null ? {} : { autoSummaryEnabled: autoSummary }),
            ...(autoCompare === null ? {} : { autoCompareEnabled: autoCompare }),
          },
          $setOnInsert: { workspaceId: ctx.orgId, ...seed },
        },
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

      return NextResponse.json(
        { ok: true, review, history, ...(autoSummary === null ? {} : { autoSummary }), ...(autoCompare === null ? {} : { autoCompare }) },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save defaults";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


