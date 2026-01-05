/**
 * API route for `/api/dashboard/usage-daily` — daily usage series for the dashboard Usage tab chart.
 *
 * Customer-facing: returns credits totals and optional derived spend (credits × USD_CENTS_PER_CREDIT).
 * Never returns tokens or provider raw telemetry.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { USD_CENTS_PER_CREDIT } from "@/lib/billing/pricing";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampDays(v: string | null): 1 | 7 | 30 {
  const n = Number(v);
  if (n === 1) return 1;
  if (n === 7) return 7;
  return 30;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function dayKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type UsageDailyResponse = {
  ok: true;
  days: 1 | 7 | 30;
  canViewSpend: boolean;
  models: Array<{ key: string; label: string }>;
  series: Array<{
    day: string; // YYYY-MM-DD (UTC)
    totalCredits: number;
    totalSpendCents: number;
    byModel: Record<string, { credits: number; spendCents: number }>;
  }>;
};

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.userId)) return NextResponse.json({ error: "Invalid user" }, { status: 400 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const url = new URL(request.url);
      const days = clampDays(url.searchParams.get("days"));

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);

      // Permission for "Spend" (owner/admin only), consistent with /api/dashboard/usage.
      const membership = await OrgMembershipModel.findOne({
        orgId,
        userId: new Types.ObjectId(actor.userId),
        isDeleted: { $ne: true },
      })
        .select({ role: 1 })
        .lean();
      const role = typeof (membership as any)?.role === "string" ? String((membership as any).role) : "";
      const canViewSpend = role === "owner" || role === "admin";

      const endDay = startOfUtcDay(new Date());
      const startDay = (() => {
        const d = new Date(endDay);
        d.setUTCDate(d.getUTCDate() - (days - 1));
        return d;
      })();
      const endExclusive = (() => {
        const d = new Date(endDay);
        d.setUTCDate(d.getUTCDate() + 1);
        return d;
      })();

      // Aggregate from ledger for the (bounded) window. Charged only.
      const rows = (await CreditLedgerModel.aggregate([
        {
          $match: {
            workspaceId: orgId,
            eventType: "ai_run",
            status: "charged",
            createdDate: { $gte: startDay, $lt: endExclusive },
          },
        },
        {
          $project: {
            day: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate", timezone: "UTC" } },
            modelRoute: 1,
            creditsCharged: 1,
          },
        },
        {
          $group: {
            _id: { day: "$day", modelRoute: "$modelRoute" },
            credits: { $sum: "$creditsCharged" },
          },
        },
        { $sort: { "_id.day": 1 } },
      ])) as Array<{ _id: { day: string; modelRoute?: string | null }; credits?: number }>;

      const byDay = new Map<string, { totalCredits: number; byLabel: Map<string, number> }>();
      const modelTotals = new Map<string, number>();

      for (const r of rows) {
        const day = typeof r?._id?.day === "string" ? r._id.day : "";
        if (!day) continue;
        const label = (r?._id?.modelRoute ?? "").trim() || "default";
        const credits = typeof r?.credits === "number" && Number.isFinite(r.credits) ? Math.max(0, Math.floor(r.credits)) : 0;
        if (credits <= 0) continue;

        const bucket = byDay.get(day) ?? { totalCredits: 0, byLabel: new Map<string, number>() };
        bucket.totalCredits += credits;
        bucket.byLabel.set(label, (bucket.byLabel.get(label) ?? 0) + credits);
        byDay.set(day, bucket);

        modelTotals.set(label, (modelTotals.get(label) ?? 0) + credits);
      }

      const sortedLabels = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
      const TOP_N = 6;
      const top = sortedLabels.slice(0, TOP_N);
      const hasOther = sortedLabels.length > TOP_N;

      const models: UsageDailyResponse["models"] = [
        ...top.map((label, i) => ({ key: `m${i}`, label })),
        ...(hasOther ? [{ key: "other", label: "other" }] : []),
      ];

      const labelToKey = new Map<string, string>();
      for (const [i, label] of top.entries()) labelToKey.set(label, `m${i}`);
      for (const label of sortedLabels.slice(TOP_N)) labelToKey.set(label, "other");

      const series: UsageDailyResponse["series"] = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(startDay);
        d.setUTCDate(d.getUTCDate() + i);
        const day = dayKeyUtc(d);

        const bucket = byDay.get(day) ?? { totalCredits: 0, byLabel: new Map<string, number>() };
        const byModel: Record<string, { credits: number; spendCents: number }> = {};

        for (const m of models) byModel[m.key] = { credits: 0, spendCents: 0 };
        for (const [label, credits] of bucket.byLabel.entries()) {
          const key = labelToKey.get(label) ?? "other";
          if (!byModel[key]) continue;
          byModel[key].credits += Math.max(0, Math.floor(credits));
        }
        for (const m of models) {
          const c = byModel[m.key]?.credits ?? 0;
          byModel[m.key] = { credits: c, spendCents: c * USD_CENTS_PER_CREDIT };
        }

        const totalCredits = Math.max(0, Math.floor(bucket.totalCredits));
        series.push({
          day,
          totalCredits,
          totalSpendCents: totalCredits * USD_CENTS_PER_CREDIT,
          byModel,
        });
      }

      const payload: UsageDailyResponse = { ok: true, days, canViewSpend, models, series };
      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load daily usage";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


