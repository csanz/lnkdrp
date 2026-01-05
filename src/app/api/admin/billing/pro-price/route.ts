/**
 * Admin API route: `/api/admin/billing/pro-price`
 *
 * Lets admins refresh the Pro price label from Stripe and persist it in MongoDB so
 * customer-facing endpoints can read it without hitting Stripe.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { BillingConfigModel } from "@/lib/models/BillingConfig";
import { revalidateBillingProPriceLabel } from "@/lib/billing/proPriceLabel";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

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

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const stripeKey = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  const priceId = (process.env.STRIPE_PRICE_ID ?? "").trim();
  if (!stripeKey || !priceId) {
    return NextResponse.json({ error: "Missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID" }, { status: 400 });
  }

  const stripe = new Stripe(stripeKey);
  const price = await stripe.prices.retrieve(priceId);
  const unitAmount = typeof (price as any)?.unit_amount === "number" ? (price as any).unit_amount : null;
  const currency = typeof (price as any)?.currency === "string" ? String((price as any).currency) : "usd";
  const interval = typeof (price as any)?.recurring?.interval === "string" ? String((price as any).recurring.interval) : "month";
  if (typeof unitAmount !== "number" || !Number.isFinite(unitAmount)) {
    return NextResponse.json({ error: "Stripe price missing unit_amount" }, { status: 400 });
  }
  const proPriceLabel = formatPriceLabel({ unitAmount, currency, interval });

  await connectMongo();
  await BillingConfigModel.updateOne(
    { key: "global" },
    { $setOnInsert: { key: "global" }, $set: { proPriceLabel } },
    { upsert: true },
  );

  // Invalidate cache so dashboard starts showing the new value immediately.
  revalidateBillingProPriceLabel();

  const updated = await BillingConfigModel.findOne({ key: "global" })
    .select({ proPriceLabel: 1, updatedDate: 1 })
    .lean();
  const updatedDate = (updated as any)?.updatedDate instanceof Date ? (updated as any).updatedDate.toISOString() : null;
  return NextResponse.json({ ok: true, proPriceLabel, updatedDate });
}


