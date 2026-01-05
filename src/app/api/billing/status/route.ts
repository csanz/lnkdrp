/**
 * API route for `/api/billing/status` — returns current user's billing state.
 *
 * Workspace-bound: this returns the current **active org/workspace** subscription state.
 *
 * This is used by the `/billing/success` page to poll until Stripe webhooks have updated MongoDB.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { OrgModel } from "@/lib/models/Org";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";

function formatPriceLabel(params: { unitAmount: number; currency: string; interval: string }): string {
  const { unitAmount, currency, interval } = params;
  const amount = unitAmount / 100;
  const cur = (currency || "usd").toUpperCase();
  const suffix = interval === "month" ? "/mo" : interval === "year" ? "/yr" : `/${interval}`;
  try {
    return `${new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(amount)}${suffix}`;
  } catch {
    return `$${amount.toFixed(0)}${suffix}`;
  }
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      const org = await OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } })
        .select({ name: 1, avatarUrl: 1 })
        .lean();
      const orgName = typeof (org as any)?.name === "string" ? String((org as any).name).trim() : "";
      const orgAvatarUrl =
        typeof (org as any)?.avatarUrl === "string" ? String((org as any).avatarUrl).trim() : "";

      const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({ status: 1, currentPeriodEnd: 1, cancelAtPeriodEnd: 1 })
        .lean();

      const statusRaw = typeof (sub as any)?.status === "string" ? String((sub as any).status).trim() : "";
      const stripeSubscriptionStatus = statusRaw || "free";
      const plan = stripeSubscriptionStatus === "active" || stripeSubscriptionStatus === "trialing" ? "pro" : "free";
      const stripeCurrentPeriodEnd =
        (sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toISOString() : null;
      const stripeCancelAtPeriodEnd = Boolean((sub as any)?.cancelAtPeriodEnd);

      // Best-effort: include a display label for the Pro monthly price (used by the dashboard UI).
      // This is server-only and does not expose secrets.
      let proPriceLabel: string | null = null;
      try {
        const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
        const priceId = (process.env.STRIPE_PRICE_ID ?? "").trim();
        if (stripeKey && priceId) {
          const stripe = new Stripe(stripeKey);
          const price = await stripe.prices.retrieve(priceId);
          const unitAmount = typeof (price as any)?.unit_amount === "number" ? (price as any).unit_amount : null;
          const currency = typeof (price as any)?.currency === "string" ? String((price as any).currency) : "usd";
          const interval = typeof (price as any)?.recurring?.interval === "string" ? String((price as any).recurring.interval) : "month";
          if (typeof unitAmount === "number" && Number.isFinite(unitAmount)) {
            proPriceLabel = formatPriceLabel({ unitAmount, currency, interval });
          }
        }
      } catch {
        // ignore (best-effort)
      }

      return NextResponse.json({
        org: { id: String(orgId), name: orgName || null, avatarUrl: orgAvatarUrl || null },
        plan,
        stripeSubscriptionStatus: stripeSubscriptionStatus || null,
        stripeCurrentPeriodEnd,
        stripeCancelAtPeriodEnd,
        proPriceLabel,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


