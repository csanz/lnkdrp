/**
 * API route for `/api/billing/invoices`.
 *
 * Returns recent invoices for the active workspace (Stripe customer portal view).
 * Customer-facing: never returns Stripe customer ids.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import Stripe from "stripe";

import { connectMongo } from "@/lib/mongodb";
import { resolveActorForStats } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mustGetEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  stripeClient = new Stripe(mustGetEnv("STRIPE_SECRET_KEY"));
  return stripeClient;
}

type InvoicesCacheEntry = { at: number; json: any };
// Stripe p99 latency can be multi-second; serve cached invoices fast and refresh in background.
const INVOICES_CACHE_FRESH_MS = 60_000;
const INVOICES_CACHE_STALE_MS = 10 * 60_000;
const INVOICES_CACHE_MAX = 50;
const invoicesCache = new Map<string, InvoicesCacheEntry>();
const invoicesRefreshInflight = new Set<string>();

function cacheKey(customerId: string, month: string | null): string {
  return `${customerId}:${month ?? ""}`;
}

function getCachedInvoices(customerId: string, month: string | null): any | null {
  const k = cacheKey(customerId, month);
  const e = invoicesCache.get(k);
  if (!e) return null;
  // Keep stale entries for a while; caller can decide whether to refresh.
  if (Date.now() - e.at > INVOICES_CACHE_STALE_MS) {
    invoicesCache.delete(k);
    return null;
  }
  // Refresh recency
  invoicesCache.delete(k);
  invoicesCache.set(k, e);
  return e.json;
}

function setCachedInvoices(customerId: string, month: string | null, json: any) {
  const k = cacheKey(customerId, month);
  invoicesCache.set(k, { at: Date.now(), json });
  while (invoicesCache.size > INVOICES_CACHE_MAX) {
    const oldest = invoicesCache.keys().next().value as string | undefined;
    if (!oldest) break;
    invoicesCache.delete(oldest);
  }
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

type InvoiceRow = {
  date: string;
  description: string;
  status: string;
  amountCents: number;
  currency: string;
  hostedInvoiceUrl: string | null;
};

// Newest month first: the client renders the picker's options in the order we send them.
function sortMonthsDesc(months: string[]): string[] {
  return [...months].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

function monthsOf(invoices: Stripe.Invoice[]): string[] {
  return sortMonthsDesc(
    Array.from(
      new Set(
        invoices
          .map((inv) => (typeof inv?.created === "number" ? fmtMonthUtc(new Date(inv.created * 1000)) : null))
          .filter((m): m is string => Boolean(m)),
      ),
    ),
  );
}

function rowsFor(invoices: Stripe.Invoice[], month: string): InvoiceRow[] {
  return invoices
    .filter((inv) => typeof inv?.created === "number" && fmtMonthUtc(new Date(inv.created * 1000)) === month)
    .map((inv) => {
      const dateIso =
        typeof inv?.created === "number" ? new Date(inv.created * 1000).toISOString() : new Date().toISOString();
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
}

/**
 * Every month this customer has an invoice in — never narrowed to the month being viewed.
 *
 * The month list used to be derived from the same month-scoped listing that produced the rows, so
 * a request carrying `?month=` answered with exactly that one month. The client disables its
 * <select> at `months.length <= 1`, so picking a month switched the picker off and the customer
 * could not reach any other month without reloading the page.
 *
 * The list only changes when Stripe issues a new invoice, so it comes from the unfiltered listing
 * already cached under the no-month key: the tab's first load sends no month and fills that entry,
 * so a month-scoped request normally costs no extra Stripe round trip. When the entry has expired
 * we list once and re-seed it, which also makes the next unfiltered load a cache hit.
 */
async function getAllMonths(stripe: Stripe, customerId: string): Promise<string[]> {
  const cachedAll = getCachedInvoices(customerId, null);
  if (cachedAll && Array.isArray(cachedAll.months)) {
    return (cachedAll.months as unknown[]).filter((m): m is string => typeof m === "string");
  }

  const list = await stripe.invoices.list({ customer: customerId, limit: 100 });
  const invoices = Array.isArray(list?.data) ? list.data : [];
  const months = monthsOf(invoices);
  const selectedMonth = months[0] ?? fmtMonthUtc(new Date());
  // This is exactly the payload an unfiltered request would return, so it can serve one.
  setCachedInvoices(customerId, null, { months, selectedMonth, invoices: rowsFor(invoices, selectedMonth) });
  return months;
}

/**
 * The response body for one (customer, month) pair. Shared by the cache-miss path and the
 * background refresh so the two cannot drift — they were duplicated line for line, and the month
 * list was wrong in both.
 */
async function computeInvoicesJson(
  stripe: Stripe,
  customerId: string,
  monthParam: string | null,
): Promise<{ months: string[]; selectedMonth: string; invoices: InvoiceRow[] }> {
  if (!monthParam) {
    // Initial load: one unfiltered listing gives both the month selector and the newest month's rows.
    const list = await stripe.invoices.list({ customer: customerId, limit: 100 });
    const invoices = Array.isArray(list?.data) ? list.data : [];
    const months = monthsOf(invoices);
    const selectedMonth = months[0] ?? fmtMonthUtc(new Date());
    return { months, selectedMonth, invoices: rowsFor(invoices, selectedMonth) };
  }

  // A month was requested: ask Stripe for that month only (dramatically reduces data and latency),
  // but take the picker's options from the unfiltered listing, which the cache normally serves.
  const createdRange = monthRangeUtc(monthParam);
  const [list, allMonths] = await Promise.all([
    stripe.invoices.list({
      customer: customerId,
      limit: 100,
      ...(createdRange ? { created: createdRange as any } : null),
    }),
    getAllMonths(stripe, customerId),
  ]);
  const invoices = Array.isArray(list?.data) ? list.data : [];
  // Keep the viewed month selectable even if it turns out to carry no invoice of its own.
  const months = allMonths.includes(monthParam) ? allMonths : sortMonthsDesc([...allMonths, monthParam]);
  return { months, selectedMonth: monthParam, invoices: rowsFor(invoices, monthParam) };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActorForStats(request);
    try {
      if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400 });

      /**
       * Owner or admin, the same bar `/api/billing/spend` and the portal use.
       *
       * Membership alone was the gate, and every row this returns carries `hostedInvoiceUrl` —
       * Stripe's hosted invoice page, which shows the payer's billing name, address and card
       * last4. A `viewer` invited to read one deck could read the owner's billing identity.
       */
      const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
      if (!role.ok) {
        return NextResponse.json(
          { error: "Only an owner or admin can see this workspace's invoices." },
          { status: 403 },
        );
      }
      const keyForbidden = forbidApiKey(actor, "read billing invoices");
      if (keyForbidden) return keyForbidden;

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

      const k = cacheKey(stripeCustomerId, monthParam);
      const cached = getCachedInvoices(stripeCustomerId, monthParam);
      const cachedAt = cached ? (invoicesCache.get(k)?.at ?? 0) : 0;
      const cachedAge = cachedAt ? Date.now() - cachedAt : Infinity;
      const cachedFresh = cached && cachedAge <= INVOICES_CACHE_FRESH_MS;

      if (cached) {
        // Serve cached immediately to avoid Stripe tail latency.
        // If stale, refresh in background (best-effort).
        if (!cachedFresh && !invoicesRefreshInflight.has(k)) {
          invoicesRefreshInflight.add(k);
          void (async () => {
            try {
              const stripe = getStripe();
              const json = await computeInvoicesJson(stripe, stripeCustomerId, monthParam);
              setCachedInvoices(stripeCustomerId, monthParam, json);
            } catch {
              // ignore: best-effort refresh
            } finally {
              invoicesRefreshInflight.delete(k);
            }
          })();
        }

        return NextResponse.json(cached, {
          headers: {
            // Private cache: safe for browsers; server-side cache handles p99.
            "cache-control": "private, max-age=30, stale-while-revalidate=600",
            "x-lnkd-cache": cachedFresh ? "hit" : "stale",
          },
        });
      }

      const stripe = getStripe();
      const json = await computeInvoicesJson(stripe, stripeCustomerId, monthParam);
      setCachedInvoices(stripeCustomerId, monthParam, json);
      return NextResponse.json(json, {
        headers: {
          "cache-control": "private, max-age=30, stale-while-revalidate=600",
          "x-lnkd-cache": "miss",
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load invoices";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  });
}


