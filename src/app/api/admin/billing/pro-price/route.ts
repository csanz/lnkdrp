/**
 * Admin API route: `/api/admin/billing/pro-price`
 *
 * Lets admins refresh the Pro price label from Stripe and persist it in MongoDB so
 * customer-facing endpoints can read it without hitting Stripe.
 */
import { NextResponse } from "next/server";

import { connectMongo } from "@/lib/mongodb";
import { BillingConfigModel } from "@/lib/models/BillingConfig";
import { readProPriceLabelsFromStripe } from "@/lib/billing/proPriceFromStripe";
import { revalidateBillingProPriceLabel } from "@/lib/billing/proPriceLabel";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export const runtime = "nodejs";

/** The stored Pro price label and when it was last written. */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  await connectMongo();
  const doc = await BillingConfigModel.findOne({ key: "global" })
    .select({ proPriceLabel: 1, updatedDate: 1 })
    .lean();
  const proPriceLabel = typeof (doc as any)?.proPriceLabel === "string" ? String((doc as any).proPriceLabel).trim() : "";
  const updatedDate = (doc as any)?.updatedDate instanceof Date ? (doc as any).updatedDate.toISOString() : null;
  return NextResponse.json({ ok: true, proPriceLabel: proPriceLabel || null, updatedDate });
}

/** Re-read the Pro prices from Stripe and store their labels. */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let labels: Awaited<ReturnType<typeof readProPriceLabelsFromStripe>>;
  try {
    labels = await readProPriceLabelsFromStripe();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  if (!labels) {
    return NextResponse.json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID" }, { status: 400 });
  }
  const { proPriceLabel, proAnnualPriceLabel, proAnnualPerMonthLabel } = labels;

  await connectMongo();
  await BillingConfigModel.updateOne(
    { key: "global" },
    { $setOnInsert: { key: "global" }, $set: { proPriceLabel, proAnnualPriceLabel, proAnnualPerMonthLabel } },
    { upsert: true },
  );

  // Invalidate cache so dashboard starts showing the new value immediately.
  revalidateBillingProPriceLabel();

  const updated = await BillingConfigModel.findOne({ key: "global" })
    .select({ proPriceLabel: 1, updatedDate: 1 })
    .lean();
  const updatedDate = (updated as any)?.updatedDate instanceof Date ? (updated as any).updatedDate.toISOString() : null;
  return NextResponse.json({ ok: true, proPriceLabel, proAnnualPriceLabel, proAnnualPerMonthLabel, updatedDate });
}


