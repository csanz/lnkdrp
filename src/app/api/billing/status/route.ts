/**
 * API route for `/api/billing/status` — returns current user's billing state.
 *
 * Workspace-bound: this returns the current **active org/workspace** subscription state.
 *
 * This is used by the `/billing/success` page to poll until Stripe webhooks have updated MongoDB.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { OrgModel } from "@/lib/models/Org";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { getBillingProPriceLabel } from "@/lib/billing/proPriceLabel";
import { BillingConfigModel } from "@/lib/models/BillingConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Short-lived in-memory cache to keep the dashboard feeling instant.
// This endpoint is polled rarely (billing/success) and read frequently (dashboard),
// so a small TTL dramatically reduces repeated DB round-trips without risking staleness.
const BILLING_STATUS_CACHE_TTL_MS = 15_000;
let billingStatusCache: Map<string, { at: number; payload: any }> | null = null;

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const orgIdStr = String(actor.orgId);
      billingStatusCache = billingStatusCache ?? new Map();
      const cached = billingStatusCache.get(orgIdStr);
      const benchmarkMode = request.headers.get("x-lnkdrp-benchmark") === "1";
      if (!benchmarkMode && cached && Date.now() - cached.at < BILLING_STATUS_CACHE_TTL_MS) {
        return NextResponse.json(cached.payload, { headers: { "cache-control": "no-store" } });
      }

      await connectMongo();
      const orgId = new Types.ObjectId(actor.orgId);
      const [org, sub, price] = await Promise.all([
        OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } }).select({ name: 1, avatarUrl: 1 }).lean(),
        SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
          .select({ status: 1, currentPeriodEnd: 1, cancelAtPeriodEnd: 1 })
          .lean(),
        benchmarkMode
          ? (async () => {
              const doc = await BillingConfigModel.findOne({ key: "global" })
                .select({ proPriceLabel: 1 })
                .lean();
              const proPriceLabel =
                typeof (doc as any)?.proPriceLabel === "string" ? String((doc as any).proPriceLabel).trim() : "";
              return { proPriceLabel: proPriceLabel || null };
            })()
          : getBillingProPriceLabel(),
      ]);

      const orgName = typeof (org as any)?.name === "string" ? String((org as any).name).trim() : "";
      const orgAvatarUrl = typeof (org as any)?.avatarUrl === "string" ? String((org as any).avatarUrl).trim() : "";

      const statusRaw = typeof (sub as any)?.status === "string" ? String((sub as any).status).trim() : "";
      const stripeSubscriptionStatus = statusRaw || "free";
      const plan = stripeSubscriptionStatus === "active" || stripeSubscriptionStatus === "trialing" ? "pro" : "free";
      const stripeCurrentPeriodEnd =
        (sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toISOString() : null;
      const stripeCancelAtPeriodEnd = Boolean((sub as any)?.cancelAtPeriodEnd);

      const payload = {
        org: { id: String(orgId), name: orgName || null, avatarUrl: orgAvatarUrl || null },
        plan,
        stripeSubscriptionStatus: stripeSubscriptionStatus || null,
        stripeCurrentPeriodEnd,
        stripeCancelAtPeriodEnd,
        proPriceLabel: (price as any)?.proPriceLabel ? String((price as any).proPriceLabel).trim() || null : null,
      };

      if (!benchmarkMode) {
        // Best-effort cache write (keep map bounded).
        billingStatusCache.set(orgIdStr, { at: Date.now(), payload });
        if (billingStatusCache.size > 50) {
          // Drop oldest-ish entry (best-effort, O(n)).
          let oldestKey: string | null = null;
          let oldestAt = Infinity;
          for (const [k, v] of billingStatusCache.entries()) {
            if (v.at < oldestAt) {
              oldestAt = v.at;
              oldestKey = k;
            }
          }
          if (oldestKey) billingStatusCache.delete(oldestKey);
        }
      }

      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}


