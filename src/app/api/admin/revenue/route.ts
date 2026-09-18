/**
 * `GET /api/admin/revenue?days=30` — what the deployment earns, for the admin home.
 *
 * Everything here comes from our own collections; Stripe invoices are not stored locally, so this
 * reports run-rate and charges, never "money received". The Pro price comes from BillingConfig
 * (written by the admin billing tool from the live Stripe price), so a price change is reflected
 * without a deploy; when it is missing, MRR is null rather than a guess.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { BillingConfigModel } from "@/lib/models/BillingConfig";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { CreditPurchaseModel } from "@/lib/models/CreditPurchase";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { OrgModel } from "@/lib/models/Org";
import { isPaygSubscription, isProSubscription } from "@/lib/billing/subscriptionState";
import { fillDays, onDemandCents, priceLabelToCents, trendPct, type RevenueDay } from "@/lib/admin/revenue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90] as const;

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const url = new URL(request.url);
  const daysRaw = Number(url.searchParams.get("days") ?? 30);
  const days = (ALLOWED_DAYS as readonly number[]).includes(daysRaw) ? daysRaw : 30;

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

  await connectMongo();

  // Subscription rows are one per workspace, so this is bounded by the number of workspaces; the
  // status/kind pair is what decides Pro vs pay-as-you-go (never `status` alone).
  const [subs, orgCount, billing] = await Promise.all([
    SubscriptionModel.find({ isDeleted: { $ne: true } })
      .select({ status: 1, kind: 1, cancelAtPeriodEnd: 1 })
      .limit(5000)
      .lean(),
    OrgModel.countDocuments({ isDeleted: { $ne: true } }),
    BillingConfigModel.findOne({ key: "global" }).select({ proPriceLabel: 1 }).lean(),
  ]);

  let proActive = 0;
  let proEnding = 0;
  let payg = 0;
  let otherBillable = 0;
  for (const s of subs) {
    const like = s as { status?: unknown; kind?: unknown; cancelAtPeriodEnd?: unknown };
    if (isProSubscription(like)) {
      proActive += 1;
      if (like.cancelAtPeriodEnd === true) proEnding += 1;
    } else if (isPaygSubscription(like)) {
      payg += 1;
    } else if (typeof like.status === "string" && like.status !== "free" && like.status !== "canceled") {
      otherBillable += 1;
    }
  }

  const proPriceLabel = typeof (billing as { proPriceLabel?: unknown } | null)?.proPriceLabel === "string"
    ? String((billing as { proPriceLabel?: string }).proPriceLabel)
    : null;
  const proPriceCents = priceLabelToCents(proPriceLabel);

  // Real charges: one row per pack Stripe confirmed.
  const packAgg = await CreditPurchaseModel.aggregate<{ _id: string; cents: number; count: number }>([
    { $match: { purchasedAt: { $gte: prevSince } } },
    {
      $group: {
        _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$purchasedAt" } }, recent: { $gte: ["$purchasedAt", since] } },
        cents: { $sum: "$amountCents" },
        count: { $sum: 1 },
      },
    },
    { $project: { _id: "$_id.day", recent: "$_id.recent", cents: 1, count: 1 } },
    { $sort: { _id: 1 } },
  ]);

  // Metered usage: charged AI runs that drew on on-demand credits. Priced, not invoiced.
  const onDemandAgg = await CreditLedgerModel.aggregate<{ _id: string; credits: number }>([
    { $match: { status: "charged", eventType: "ai_run", creditsFromOnDemand: { $gt: 0 }, createdDate: { $gte: prevSince } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdDate" } }, credits: { $sum: "$creditsFromOnDemand" } } },
    { $sort: { _id: 1 } },
  ]);

  const sinceKey = since.toISOString().slice(0, 10);
  const byDay = new Map<string, RevenueDay>();
  for (const row of packAgg) {
    const day = String(row._id);
    const cur = byDay.get(day) ?? { day, packCents: 0, onDemandCents: 0 };
    cur.packCents += Number(row.cents) || 0;
    byDay.set(day, cur);
  }
  for (const row of onDemandAgg) {
    const day = String(row._id);
    const cur = byDay.get(day) ?? { day, packCents: 0, onDemandCents: 0 };
    cur.onDemandCents += onDemandCents(Number(row.credits) || 0);
    byDay.set(day, cur);
  }

  const all = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const windowDays = fillDays(all.filter((d) => d.day >= sinceKey), since, until);
  const previous = all.filter((d) => d.day < sinceKey);

  const sum = (rows: RevenueDay[], key: "packCents" | "onDemandCents") => rows.reduce((n, r) => n + r[key], 0);
  const packCents = sum(windowDays, "packCents");
  const onDemand = sum(windowDays, "onDemandCents");
  const chargedCents = packCents + onDemand;
  const previousChargedCents = sum(previous, "packCents") + sum(previous, "onDemandCents");
  const packCount = packAgg.filter((r) => String(r._id) >= sinceKey).reduce((n, r) => n + (Number(r.count) || 0), 0);

  return NextResponse.json({
    ok: true,
    days,
    since: since.toISOString(),
    subscriptions: { proActive, proEnding, payg, otherBillable, free: Math.max(0, orgCount - proActive - payg - otherBillable) },
    price: { proPriceLabel, proPriceCents },
    summary: {
      mrrCents: proPriceCents === null ? null : proActive * proPriceCents,
      endingCents: proPriceCents === null ? null : proEnding * proPriceCents,
      packCents,
      onDemandCents: onDemand,
      chargedCents,
      previousChargedCents,
      trendPct: trendPct(chargedCents, previousChargedCents),
      packCount,
    },
    series: windowDays,
  });
}
