"use client";

/**
 * Client-only billing actions (Stripe Checkout + Billing Portal).
 *
 * IMPORTANT:
 * - Must not be imported from server files.
 * - Behavior should match existing dashboard CTA implementations.
 */

type StripeRedirectResponse = { url?: string; error?: string } | null;

/**
 * Extracts and normalizes a redirect URL from Stripe redirect endpoints.
 *
 * Exists to keep URL parsing consistent across Checkout + Billing Portal flows.
 * Returns an empty string when missing/invalid.
 */
function parseUrl(json: StripeRedirectResponse): string {
  const url = typeof json?.url === "string" ? json.url : "";
  return url.trim();
}

/**
 * Starts Stripe Checkout by calling `/api/stripe/checkout` and redirecting the browser.
 *
 * `plan` defaults to `"pro"`. `"payg"` creates a $0 subscription that exists only to hold a card
 * and a place to bill metered usage — for a Free workspace that wants on-demand credits without
 * upgrading. Errors: throws when the API responds with an error (409 when the workspace already
 * has a billable subscription of either kind) or returns an invalid redirect URL.
 * Side effects: navigates via `window.location.assign`.
 */
export async function startCheckout(plan: "pro" | "payg" = "pro"): Promise<void> {
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  const json = (await res.json().catch(() => null)) as StripeRedirectResponse;
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  const url = parseUrl(json);
  if (!url) throw new Error("Invalid response");
  window.location.assign(url);
}

/**
 * Opens Stripe Billing Portal by calling `/api/stripe/portal` and navigating to the returned URL.
 *
 * Side effects: navigates current tab by default, or opens a new tab when `target: "_blank"`.
 * Errors: throws when the API responds with an error or returns an invalid portal URL.
 */
export async function openBillingPortal(opts?: { target?: "_self" | "_blank" }): Promise<void> {
  const res = await fetch("/api/stripe/portal", { method: "POST" });
  const json = (await res.json().catch(() => null)) as StripeRedirectResponse;
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  const url = parseUrl(json);
  if (!url) throw new Error("Invalid portal URL");

  if (opts?.target === "_blank") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  window.location.assign(url);
}


