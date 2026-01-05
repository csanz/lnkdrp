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
import { resolveActor } from "@/lib/gating/actor";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { UsageAggCycleModel } from "@/lib/models/UsageAggCycle";
import { ALLOWED_LIMITS, UNLIMITED_LIMIT_CENTS } from "@/lib/billing/limits";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function isProStatus(status: unknown): boolean {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function startOfNextUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      const userId = new Types.ObjectId(actor.userId);

      // Editing limits is restricted to owners/admins AND requires an active subscription (Pro).
      const [sub, membership] = await Promise.all([
        SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
          .select({ status: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
          .lean(),
        OrgMembershipModel.findOne({ orgId, userId, isDeleted: { $ne: true } }).select({ role: 1 }).lean(),
      ]);
      const isPro = isProStatus((sub as any)?.status);
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      const roleAllowsEdit = role === "owner" || role === "admin";
      const canEdit = isPro && roleAllowsEdit;
      const editDisabledReason = !isPro ? "On-demand limits require an active Pro subscription." : !roleAllowsEdit ? "Only workspace owners/admins can edit limits." : null;

      const bal = await WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId })
        .select({ onDemandEnabled: 1, onDemandMonthlyLimitCents: 1, currentPeriodStart: 1, currentPeriodEnd: 1 })
        .lean();
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
        const cycleKey = `${actor.orgId}:${cycleStart.toISOString()}`;

        const agg = await UsageAggCycleModel.findOne({ workspaceId: orgId, cycleKey })
          .select({ onDemandUsedCredits: 1 })
          .lean();
        if (agg) {
          usedCreditsThisCycle =
            typeof (agg as any)?.onDemandUsedCredits === "number" && Number.isFinite((agg as any).onDemandUsedCredits)
              ? Math.max(0, Math.floor((agg as any).onDemandUsedCredits))
              : 0;
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

      const centsPerCredit = USD_CENTS_PER_CREDIT;
      const usedCents = Math.max(0, usedCreditsThisCycle) * centsPerCredit;

      return NextResponse.json(
        {
          ok: true,
          onDemandEnabled: enabled,
          onDemandMonthlyLimitCents: enabled ? limitCents : 0,
          onDemandUsedCentsThisCycle: usedCents,
          canEdit,
          editDisabledReason,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
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
      const orgId = new Types.ObjectId(actor.orgId);
      const userId = new Types.ObjectId(actor.userId);

      // On-demand limits require an active subscription (Pro).
      const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ status: 1 }).lean();
      if (!isProStatus((sub as any)?.status)) {
        return NextResponse.json({ error: "On-demand limits require an active Pro subscription." }, { status: 403 });
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


