/**
 * Cron route: `POST /api/cron/stripe-credits-report`
 *
 * Reports metered AI credit usage to Stripe for Pro workspaces.
 *
 * Idempotency:
 * - only considers `CreditLedger` rows where `status="charged"` and `stripeUsageReportedAt=null`
 * - also sends a deterministic Stripe idempotency key per (subscriptionItemId + ledgerIds batch)
 */
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { CronHealthModel } from "@/lib/models/CronHealth";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { batchIdempotencyKey, groupOnDemandLedgersForStripe } from "@/lib/credits/stripeReporting";
import { logErrorEvent, ERROR_CODE_CRON_JOB_FAILED } from "@/lib/errors/logger";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.LNKDRP_CRON_SECRET;
  if (secret) {
    const provided =
      request.headers.get("x-cron-secret") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      url.searchParams.get("secret");
    if (!provided || provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startedAt = new Date();
  const jobKey = "stripe-credits-report";

  try {
    await connectMongo();
    await CronHealthModel.updateOne(
      { jobKey },
      {
        $set: {
          status: "running",
          lastStartedAt: startedAt,
          lastRunAt: startedAt,
          lastParams: {},
          lastError: null,
        },
      },
      { upsert: true },
    );
  } catch {
    // ignore
  }

  try {
    const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
    if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY");
    const stripe = new Stripe(stripeKey);

    await connectMongo();

    // Pull a bounded batch for safety.
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "200") || 200));

    // Map workspace → subscription item (only report for active Pro subscriptions with a known metered item).
    const subs = await SubscriptionModel.find({
      isDeleted: { $ne: true },
      status: { $in: ["active", "trialing"] },
      stripeSubscriptionItemId: { $ne: null },
    })
      .select({ orgId: 1, stripeSubscriptionItemId: 1 })
      .lean();
    const itemByWorkspace = new Map<string, string>();
    const workspaceObjectIds: Types.ObjectId[] = [];
    for (const s of subs) {
      const orgId = (s as any)?.orgId ? String((s as any).orgId) : "";
      const itemId =
        typeof (s as any)?.stripeSubscriptionItemId === "string" ? String((s as any).stripeSubscriptionItemId).trim() : "";
      if (orgId && itemId) itemByWorkspace.set(orgId, itemId);
      if (orgId && Types.ObjectId.isValid(orgId)) workspaceObjectIds.push(new Types.ObjectId(orgId));
    }

    if (!workspaceObjectIds.length) {
      return NextResponse.json({ ok: true, processed: 0, reported: 0 });
    }

    // IMPORTANT: Stripe metered billing should reflect only overage/on-demand usage (not included credits).
    const ledgers = await CreditLedgerModel.find({
      workspaceId: { $in: workspaceObjectIds as any },
      status: "charged",
      eventType: "ai_run",
      stripeUsageReportedAt: null,
      creditsFromOnDemand: { $gt: 0 },
    })
      .select({ _id: 1, workspaceId: 1, creditsFromOnDemand: 1 })
      .sort({ createdDate: 1 })
      .limit(limit)
      .lean();

    if (!ledgers.length) {
      return NextResponse.json({ ok: true, processed: 0, reported: 0 });
    }

    // Group by subscription item id.
    const grouped = groupOnDemandLedgersForStripe({
      ledgers: ledgers.map((l) => ({
        id: String((l as any)._id),
        workspaceId: String((l as any).workspaceId),
        creditsFromOnDemand: typeof (l as any).creditsFromOnDemand === "number" ? (l as any).creditsFromOnDemand : 0,
      })),
      subscriptionItemIdByWorkspaceId: itemByWorkspace,
    });

    if (!grouped.size) {
      return NextResponse.json({ ok: true, processed: ledgers.length, reported: 0 });
    }

    // Ensure we don't double-report in the same run if a ledger somehow appears twice.
    // (Shouldn't happen, but this keeps Stripe quantities correct.)
    // Note: group helper already uses ledger id list.

    // Map workspace → subscription item (legacy code kept for clarity in logs).
    const workspaceIds = Array.from(new Set(ledgers.map((l) => String((l as any).workspaceId))));
    void workspaceIds;

    // Grouped is already computed above.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const subsCount = subs.length;
    let reported = 0;
    const nowTs = Math.floor(Date.now() / 1000);

    for (const [subscriptionItemId, b] of grouped.entries()) {
      if (b.quantity <= 0 || !b.ledgerIds.length) continue;
      const idemKey = batchIdempotencyKey({ subscriptionItemId, ledgerIds: b.ledgerIds });

      // Stripe's TypeScript surface varies by API version; `createUsageRecord` may not be present on
      // `SubscriptionItemsResource` in newer versions even though the endpoint remains available.
      // Cast narrowly to keep the cron behavior intact while unblocking typecheck.
      await (stripe.subscriptionItems as any).createUsageRecord(
        subscriptionItemId,
        { quantity: b.quantity, timestamp: nowTs, action: "increment" },
        { idempotencyKey: idemKey },
      );

      await CreditLedgerModel.updateMany(
        { _id: { $in: b.ledgerIds as any } },
        { $set: { stripeUsageReportedAt: new Date() } },
      );
      reported += b.ledgerIds.length;
    }

    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: "ok",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastResult: { processed: ledgers.length, reported },
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }

    return NextResponse.json({ ok: true, processed: ledgers.length, reported });
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const message = err instanceof Error ? err.message : String(err);

    void logErrorEvent({
      severity: "error",
      category: "cron",
      code: ERROR_CODE_CRON_JOB_FAILED,
      err,
      request,
      statusCode: 500,
      meta: { jobKey, durationMs },
    });
    try {
      await connectMongo();
      await CronHealthModel.updateOne(
        { jobKey },
        {
          $set: {
            status: "error",
            lastFinishedAt: finishedAt,
            lastRunAt: finishedAt,
            lastDurationMs: durationMs,
            lastErrorAt: finishedAt,
            lastError: message,
          },
        },
        { upsert: true },
      );
    } catch {
      // ignore
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


