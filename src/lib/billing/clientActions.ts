"use client";

/**
 * Client-only billing actions (Stripe Checkout + Billing Portal).
 *
 * IMPORTANT:
 * - Must not be imported from server files.
 * - Behavior should match existing dashboard CTA implementations.
 */

type StripeRedirectResponse = { url?: string; error?: string } | null;

function parseUrl(json: StripeRedirectResponse): string {
  const url = typeof json?.url === "string" ? json.url : "";
  return url.trim();
}

export async function startCheckout(): Promise<void> {
  const res = await fetch("/api/stripe/checkout", { method: "POST" });
  const json = (await res.json().catch(() => null)) as StripeRedirectResponse;
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  const url = parseUrl(json);
  if (!url) throw new Error("Invalid response");
  window.location.assign(url);
}

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


