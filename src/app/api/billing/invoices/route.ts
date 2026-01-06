/**
 * API route for `/api/billing/invoices`.
 *
 * Returns recent invoices for the active workspace (Stripe customer portal view).
 * Customer-facing: never returns Stripe customer ids.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustGetEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function clampNonNegInt(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function fmtMonthUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const mm = String(m).padStart(2, "0");
  return `${y}-${mm}`;
}

function normalizeMonth(raw: string | null): string | null {
  const v = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(v)) return null;
  return v;
}

function monthRangeUtc(month: string): { gte: number; lt: number } | null {
  const m = normalizeMonth(month);
  if (!m) return null;
  const [yy, mm] = m.split("-").map((x) => Number(x));
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || mm < 1 || mm > 12) return null;
  const start = Date.UTC(yy, mm - 1, 1, 0, 0, 0, 0);
  const end = Date.UTC(yy, mm, 1, 0, 0, 0, 0);
  return { gte: Math.floor(start / 1000), lt: Math.floor(end / 1000) };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      const url = new URL(request.url);
      const monthParam = normalizeMonth(url.searchParams.get("month"));
      const orgId = new Types.ObjectId(actor.orgId);

      await connectMongo();
      const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({ stripeCustomerId: 1 })
        .lean();
      const stripeCustomerId =
        typeof (sub as any)?.stripeCustomerId === "string" ? String((sub as any).stripeCustomerId).trim() : "";

      if (!stripeCustomerId) {
        const selectedMonth = monthParam ?? fmtMonthUtc(new Date());
        return NextResponse.json(
          { months: [], selectedMonth, invoices: [] },
          { headers: { "cache-control": "no-store" } },
        );
      }

      const stripe = new Stripe(mustGetEnv("STRIPE_SECRET_KEY"));
      // If a month is requested, ask Stripe for that month only (dramatically reduces data and latency).
      // For the initial load (no month param), we still list recent invoices to populate the month selector.
      const createdRange = monthParam ? monthRangeUtc(monthParam) : null;
      const list = await stripe.invoices.list({
        customer: stripeCustomerId,
        limit: 100,
        ...(createdRange ? { created: createdRange as any } : null),
      });
      const invoices = Array.isArray(list?.data) ? list.data : [];

      const months = Array.from(
        new Set(
          invoices
            .map((inv) => (typeof inv?.created === "number" ? fmtMonthUtc(new Date(inv.created * 1000)) : null))
            .filter((m): m is string => Boolean(m)),
        ),
      ).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

      const selectedMonth = monthParam ?? months[0] ?? fmtMonthUtc(new Date());
      const filtered = invoices.filter((inv) => {
        if (typeof inv?.created !== "number") return false;
        return fmtMonthUtc(new Date(inv.created * 1000)) === selectedMonth;
      });

      const rows = filtered.map((inv) => {
        const dateIso = typeof inv?.created === "number" ? new Date(inv.created * 1000).toISOString() : new Date().toISOString();
        const descriptionRaw =
          (typeof inv?.description === "string" ? inv.description : "") ||
          (typeof inv?.statement_descriptor === "string" ? inv.statement_descriptor : "") ||
          "";
        const description = descriptionRaw.trim() || "Invoice";
        const status = typeof inv?.status === "string" ? inv.status : "unknown";
        const amountCents =
          typeof inv?.amount_paid === "number" && inv.amount_paid > 0
            ? inv.amount_paid
            : typeof inv?.amount_due === "number"
              ? inv.amount_due
              : typeof (inv as any)?.total === "number"
                ? (inv as any).total
                : 0;
        const currency = typeof inv?.currency === "string" ? inv.currency.toUpperCase() : "USD";
        const hostedInvoiceUrl = typeof inv?.hosted_invoice_url === "string" ? inv.hosted_invoice_url : null;

        return { date: dateIso, description, status, amountCents: clampNonNegInt(amountCents), currency, hostedInvoiceUrl };
      });

      return NextResponse.json(
        { months, selectedMonth, invoices: rows },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load invoices";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


