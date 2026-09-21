"use client";

/**
 * Client-only billing actions (Stripe Checkout + Billing Portal).
 *
 * IMPORTANT:
 * - Must not be imported from server files.
 * - Behavior should match existing dashboard CTA implementations.
 */

type StripeRedirectResponse = { url?: string; error?: string; message?: string; redirectTo?: string } | null;

/**
 * Turn a refusal into the right thing to do, instead of a thrown error code.
 *
 * Gates in this codebase answer `{ error: "WAITLISTED", message, redirectTo }` — a machine-readable
 * code, a sentence for a person, and where that person should actually be. These two functions used
 * to throw `json.error`, which put the literal word **WAITLISTED** on screen in a toast and left the
 * `redirectTo` the gate deliberately includes completely unused.
 *
 * Navigates when the refusal names a destination; otherwise throws the sentence, falling back to
 * the code only when there is nothing better to say.
 */
function failOrRedirect(json: StripeRedirectResponse, status: number): never | void {
  const redirectTo = typeof json?.redirectTo === "string" ? json.redirectTo.trim() : "";
  // Same-origin only: this is a path from our own API, and following an absolute URL a response
  // supplied would be an open redirect on a click the person meant as "upgrade".
  if (redirectTo.startsWith("/") && !redirectTo.startsWith("//")) {
    window.location.assign(redirectTo);
    return;
  }
  const message = typeof json?.message === "string" && json.message.trim() ? json.message.trim() : "";
  throw new Error(message || json?.error || `Request failed (${status})`);
}

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
 * Always Pro: pay-as-you-go for Free was retired (Free buys credit packs at `/credits`).
 * Errors: throws when the API responds with an error (409 when the workspace already has a
 * billable subscription) or returns an invalid redirect URL.
 * Side effects: navigates via `window.location.assign`.
 */
export async function startCheckout(): Promise<void> {
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan: "pro" }),
  });
  const json = (await res.json().catch(() => null)) as StripeRedirectResponse;
  if (!res.ok) return failOrRedirect(json, res.status);
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
export async function openBillingPortal(opts?: { target?: "_self" | "_blank"; flow?: "cancel" }): Promise<void> {
  const res = await fetch("/api/stripe/portal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts?.flow ? { flow: opts.flow } : {}),
  });
  const json = (await res.json().catch(() => null)) as StripeRedirectResponse;
  if (!res.ok) return failOrRedirect(json, res.status);
  const url = parseUrl(json);
  if (!url) throw new Error("Invalid portal URL");

  if (opts?.target === "_blank") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  window.location.assign(url);
}

/**
 * Undo a scheduled cancellation (`POST /api/stripe/subscription/resume`): the subscription renews
 * as normal. Throws with the API's message when it fails (not an admin, already ended).
 */
export async function resumeSubscription(): Promise<void> {
  const res = await fetch("/api/stripe/subscription/resume", { method: "POST" });
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
}
