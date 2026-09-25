/**
 * Report an upgrade-funnel step from the browser (`POST /api/funnel`).
 *
 * The server knows about the refusal (the 402) and about the Checkout it may lead to; the modal in
 * between, and what was pressed on it, only the browser sees. This is the one place that sends it.
 *
 * Fire-and-forget by design: never awaited in a render or click path, never throws, `keepalive`
 * so a click that navigates away (Upgrade goes to Stripe) still lands. A signed-out visitor gets a
 * 401 the caller never sees, which is the right outcome: no workspace, no funnel.
 */

/** Steps the browser reports; the route accepts exactly these. */
export type FunnelEvent = "modal_shown" | "cta_clicked";

/** What was pressed on a modal. `manage` is the monthly-Pro on-demand door, kept for completeness. */
export type FunnelCta = "upgrade" | "pack" | "compare" | "manage" | "dismiss";

/** Optional detail on a step: why the modal opened, which surface opened it, what was pressed. */
export type FunnelFields = {
  /** The upsell key (`documents`, `analytics_history`, ...) or out-of-credits reason. */
  reason?: string | null;
  /** The surface that opened the modal (`doc_page`, `sidebar`, `out_of_credits`, ...). */
  from?: string | null;
  cta?: FunnelCta | null;
};

/**
 * The surface a modal opened on, from the page path: `/doc/6ab5.../metrics` becomes
 * `doc.x.metrics`, `/dashboard` stays `dashboard`. Ids and slugs collapse to `x` so the value is a
 * route shape the funnel can group by, never an identifier.
 */
export function funnelSurface(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => (/^[a-z][a-z-]*$/.test(seg) ? seg.replace(/-/g, "_") : "x"))
    .slice(0, 6);
  return parts.length ? parts.join(".").slice(0, 64) : "home";
}

/** Send one funnel step. Returns nothing and swallows every failure. */
export function trackFunnel(event: FunnelEvent, fields: FunnelFields = {}): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  try {
    void fetch("/api/funnel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, reason: fields.reason ?? null, from: fields.from ?? null, cta: fields.cta ?? null }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => undefined);
  } catch {
    // Instrumentation never breaks the page.
  }
}
