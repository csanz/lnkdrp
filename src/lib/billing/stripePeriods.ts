/**
 * Stripe billing-period helpers.
 *
 * stripe@20 pins API version `2025-12-15.clover`, where:
 * - `current_period_start` / `current_period_end` live on subscription **items**
 *   (`sub.items.data[i].current_period_start`), not on the top-level subscription.
 * - `invoice.subscription` moved to `invoice.parent.subscription_details.subscription`.
 *
 * These helpers read the new locations first and fall back to the legacy top-level fields so
 * older webhook payloads (or a pinned older API version) keep working.
 */

/** Parse a Stripe unix-seconds timestamp (number/bigint/string) into a Date; `null` when absent/invalid. */
export function parseStripeUnixSeconds(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "bigint") return new Date(Number(v) * 1000);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    if (Number.isFinite(n)) return new Date(n * 1000);
  }
  return null;
}

/**
 * Read the current billing period of a Stripe subscription.
 *
 * Prefers `items.data[0].current_period_start/end` (API 2025-12-15+), then top-level fields.
 * Accepts a loosely-typed object so it works for webhook payloads and `subscriptions.retrieve()` results.
 */
export function getSubscriptionPeriod(sub: unknown): { start: Date | null; end: Date | null } {
  const s = (sub ?? null) as
    | {
        current_period_start?: unknown;
        current_period_end?: unknown;
        items?: { data?: Array<{ current_period_start?: unknown; current_period_end?: unknown } | null> | null } | null;
      }
    | null;
  if (!s) return { start: null, end: null };

  const items = Array.isArray(s.items?.data) ? s.items!.data! : [];
  let start: Date | null = null;
  let end: Date | null = null;
  for (const it of items) {
    if (!it) continue;
    start = start ?? parseStripeUnixSeconds(it.current_period_start);
    end = end ?? parseStripeUnixSeconds(it.current_period_end);
    if (start && end) break;
  }

  start = start ?? parseStripeUnixSeconds(s.current_period_start);
  end = end ?? parseStripeUnixSeconds(s.current_period_end);
  return { start, end };
}

function idOf(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && "id" in (v as Record<string, unknown>)) {
    const id = (v as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  }
  return "";
}

/**
 * Read the subscription id an invoice belongs to.
 *
 * Prefers `invoice.parent.subscription_details.subscription` (API 2025-12-15+), then legacy `invoice.subscription`.
 * Returns an empty string when the invoice is not tied to a subscription.
 */
export function getInvoiceSubscriptionId(invoice: unknown): string {
  const inv = (invoice ?? null) as
    | {
        parent?: { subscription_details?: { subscription?: unknown } | null } | null;
        subscription?: unknown;
      }
    | null;
  if (!inv) return "";
  const fromParent = idOf(inv.parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  return idOf(inv.subscription);
}
