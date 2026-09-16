/**
 * API route for `/api/billing/spend` — read/update workspace on-demand spend limit + usage.
 *
 * - GET: returns `{ onDemandMonthlyLimitCents, onDemandUsedCentsThisCycle }`
 * - POST: updates `onDemandMonthlyLimitCents` (cents) for the active workspace (owner/admin only)
 *
 * Primary UI unit is credits; dollars are secondary and only shown in the limit editor.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor, resolveActorForStats, tryResolveUserActorFast } from "@/lib/gating/actor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { isBillableSubscription } from "@/lib/billing/subscriptionState";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { ALLOWED_LIMITS, UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short-lived in-memory cache to keep the dashboard "Overview" and "Limits" sections snappy.
// This is safe because spend usage changes slowly, and the UI already refreshes after edits.
const BILLING_SPEND_CACHE_TTL_MS = 10_000;
let billingSpendCache: Map<string, { at: number; payload: any }> | null = null;

function toNonNegativeInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i < 0) return null;
  return i;
}

function normalizeLimitCents(v: unknown): number | null {
  const n = toNonNegativeInt(v);
  if (n === null) return null;
  // Hard cap for safety even if client sends something extreme.
  return Math.min(n, UNLIMITED_LIMIT_CENTS);
}


function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

async function resolveUserAndOrgForWorkspaceRoute(
  request: Request,
): Promise<{ ok: true; userId: string; orgId: string } | { ok: false; status: number; error: string }> {
  // Membership-validated fast path (cookie / JWT claim + one cached membership check), then the full
  // resolver. Never trust the cookie alone: a stale one pointing at another workspace used to 403 here.
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  if (actor.kind !== "user") return { ok: false, status: 401, error: "Unauthorized" };
  if (!Types.ObjectId.isValid(actor.userId)) return { ok: false, status: 400, error: "Invalid user" };
  if (!Types.ObjectId.isValid(actor.orgId)) return { ok: false, status: 400, error: "Invalid org" };
  return { ok: true, userId: actor.userId, orgId: actor.orgId };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    try {
      const ctx = await resolveUserAndOrgForWorkspaceRoute(request);
      if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

      const orgIdStr = String(ctx.orgId);
      const userIdStr = String(ctx.userId);
      billingSpendCache = billingSpendCache ?? new Map();
      const cacheKey = `${orgIdStr}:${userIdStr}`;
      const cached = billingSpendCache.get(cacheKey);
      if (cached && Date.now() - cached.at < BILLING_SPEND_CACHE_TTL_MS) {
        return NextResponse.json(cached.payload, { headers: { "cache-control": "no-store" } });
      }

      await connectMongo();
      const orgId = new Types.ObjectId(String(ctx.orgId));
      const userId = new Types.ObjectId(String(ctx.userId));

      // Fetch the "hot path" documents in parallel.
      // Note: we intentionally read membership (role) here so we can enforce membership validity
      // and also avoid a separate "exists" query.
      const [membership, sub, bal] = await Promise.all([
        OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } }).select({ role: 1 }).lean(),
        SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
          .select({ status: 1, kind: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
          .lean(),
        WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
          .select({ onDemandEnabled: 1, onDemandMonthlyLimitCents: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
          .lean(),
      ]);
      if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      // Billable, not Pro: a Free workspace that added a card (pay-as-you-go) sets its limit here too.
      const billable = isBillableSubscription(sub as { status?: unknown; kind?: unknown } | null);
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      const roleAllowsEdit = role === "owner" || role === "admin";
      const canEdit = billable && roleAllowsEdit;
      const editDisabledReason = !billable
        ? "On-demand credits need a card on file: add pay-as-you-go or upgrade to Pro."
        : !roleAllowsEdit
          ? "Only workspace owners/admins can edit limits."
          : null;

      const limitCents =
        typeof (bal as any)?.onDemandMonthlyLimitCents === "number" && Number.isFinite((bal as any).onDemandMonthlyLimitCents)
          ? Math.max(0, Math.floor((bal as any).onDemandMonthlyLimitCents))
          : 0;
      const enabled = Boolean((bal as any)?.onDemandEnabled) && limitCents > 0;

      // Usage is derived from pre-aggregated cycle usage when available (fast path), with a
      // narrow ledger aggregate fallback (avoid calling the full credits snapshot on this hot path).
      let usedCreditsThisCycle = 0;
      if (enabled) {
        const subStart = (sub as any)?.currentPeriodStart instanceof Date ? (sub as any).currentPeriodStart : null;
        const subEnd = (sub as any)?.currentPeriodEnd instanceof Date ? (sub as any).currentPeriodEnd : null;
        const balStart = (bal as any)?.currentPeriodStart instanceof Date ? (bal as any).currentPeriodStart : null;
        const balEnd = (bal as any)?.currentPeriodEnd instanceof Date ? (bal as any).currentPeriodEnd : null;
        const now = new Date();
        const cycleStart = subStart && subEnd ? subStart : balStart && balEnd ? balStart : startOfUtcMonth(now);
        const cycleEnd = subStart && subEnd ? subEnd : balStart && balEnd ? balEnd : startOfNextUtcMonth(now);
        const cycleKey = `${orgIdStr}:${cycleStart.toISOString()}`;

        const agg = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey })
          .select({ onDemandUsedCredits: 1 })
          .lean();
        if (agg) {
          usedCreditsThisCycle =
            typeof (agg as any)?.onDemandUsedCredits === "number" && Number.isFinite((agg as any).onDemandUsedCredits)
              ? Math.max(0, Math.floor((agg as any).onDemandUsedCredits))
              : 0;
        } else {
          // Prefer a tight equality match on `cycleKey` (index-friendly) and fall back to a bounded
          // createdDate range for legacy rows that don't have cycleKey.
          const fast = await CreditLedgerModel.aggregate([
            {
              $match: {
                workspaceId: orgId,
                status: "charged",
                eventType: "ai_run",
                cycleKey,
                creditsFromOnDemand: { $gt: 0 },
              },
            },
            { $group: { _id: null, sum: { $sum: "$creditsFromOnDemand" } } },
          ]);
          const fastSum = (fast as any)?.[0]?.sum;
          if (typeof fastSum === "number" && Number.isFinite(fastSum) && fastSum > 0) {
            usedCreditsThisCycle = Math.max(0, Math.floor(fastSum));
          } else {
            const rows = await CreditLedgerModel.aggregate([
              {
                $match: {
                  workspaceId: orgId,
                  status: "charged",
                  eventType: "ai_run",
                  createdDate: { $gte: cycleStart, $lt: cycleEnd },
                  creditsFromOnDemand: { $gt: 0 },
                },
              },
              { $group: { _id: null, sum: { $sum: "$creditsFromOnDemand" } } },
            ]);
            usedCreditsThisCycle =
              typeof (rows as any)?.[0]?.sum === "number" && Number.isFinite((rows as any)[0].sum)
                ? Math.max(0, Math.floor((rows as any)[0].sum))
                : 0;
          }
        }
      }

      const centsPerCredit = USD_CENTS_PER_CREDIT;
      const usedCents = Math.max(0, usedCreditsThisCycle) * centsPerCredit;

      const payload = {
        ok: true,
        onDemandEnabled: enabled,
        onDemandMonthlyLimitCents: enabled ? limitCents : 0,
        onDemandUsedCentsThisCycle: usedCents,
        canEdit,
        editDisabledReason,
      };

      billingSpendCache.set(cacheKey, { at: Date.now(), payload });
      if (billingSpendCache.size > 100) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of billingSpendCache.entries()) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey) billingSpendCache.delete(oldestKey);
      }

      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const body = (await request.json().catch(() => null)) as { spendLimitCents?: unknown } | null;
      const limitCents = normalizeLimitCents(body?.spendLimitCents);
      if (limitCents === null) return NextResponse.json({ error: "Invalid spendLimitCents" }, { status: 400 });

      // Enforce allow-list + "custom": allow any positive value up to UNLIMITED (inclusive),
      // but keep a tiny guardrail so "custom" isn't accidentally set to $0 unless explicitly chosen.
      const allowed = (ALLOWED_LIMITS as readonly number[]).includes(limitCents);
      const customOk = limitCents > 0 && limitCents <= UNLIMITED_LIMIT_CENTS;
      if (!allowed && !customOk) {
        return NextResponse.json({ error: "Spend limit not allowed" }, { status: 400 });
      }

      await connectMongo();
      const orgId = new Types.ObjectId(String(actor.orgId));
      const userId = new Types.ObjectId(String(actor.userId));

      // On-demand needs something to bill: a billable subscription of either kind (Pro, or the
      // metered-only pay-as-you-go one a Free workspace gets when it adds a card).
      const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1, kind: 1 }).lean();
      if (!isBillableSubscription(sub as { status?: unknown; kind?: unknown } | null)) {
        return NextResponse.json(
          { error: "On-demand credits need a card on file: add pay-as-you-go or upgrade to Pro." },
          { status: 403 },
        );
      }

      const membership = await OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } })
        .select({ role: 1 })
        .lean();
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      if (role !== "owner" && role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      const enabled = limitCents > 0;
      await WorkspaceCreditBalanceModel.updateOne(
        { workspaceId: orgId },
        { $set: { onDemandEnabled: enabled, onDemandMonthlyLimitCents: enabled ? limitCents : 0 } },
        { upsert: true },
      );

      // Best-effort: invalidate cached spend payloads for this org (per-user cache keys).
      try {
        if (billingSpendCache) {
          const prefix = `${String(actor.orgId)}:`;
          for (const k of Array.from(billingSpendCache.keys())) {
            if (k.startsWith(prefix)) billingSpendCache.delete(k);
          }
        }
      } catch {
        // ignore
      }

      return NextResponse.json(
        { ok: true, onDemandEnabled: enabled, onDemandMonthlyLimitCents: enabled ? limitCents : 0 },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


