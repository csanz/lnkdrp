/**
 * Cancelling a workspace's Stripe subscription from inside the product.
 *
 * Two callers need this and neither is the billing portal: deleting a team workspace
 * (`DELETE /api/orgs/:orgId`) and asking for an account to be deleted (`POST /api/account/delete`).
 * Both used to soft-delete the rows that pointed at the subscription and leave Stripe charging the
 * card every month, with nothing left in the product that could find the subscription again. The
 * account purge already cancels for solo workspaces; this module is the same rule for the two
 * moments that come before it.
 *
 * Both functions answer `{ ok: true }` when Stripe already has nothing to charge: a subscription
 * that is gone or already canceled is the goal, not a failure. They answer `{ ok: false }` when
 * Stripe refused or could not be reached, and callers must then refuse the delete rather than
 * orphan a live subscription.
 *
 * Security: server-only (reads `STRIPE_SECRET_KEY`). Callers own the permission check; this
 * module cancels whatever id it is handed.
 */
import Stripe from "stripe";

export type StripeCancelOutcome = { ok: true; already: boolean } | { ok: false; error: string };

/** A Stripe client from the environment, or null when the deployment has no Stripe key. */
function stripeClient(): Stripe | null {
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  return key ? new Stripe(key) : null;
}

/** Stripe's "no such object" error, which for our purposes means "nothing to cancel". */
function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return code === "resource_missing" || status === 404;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Cancel the subscription immediately. Used when the thing it paid for is being deleted right now.
 *
 * `prorate: true` asks Stripe to credit the unused part of the current period to the customer's
 * balance. Pass it for yearly subscriptions: a workspace deleted in month two of a prepaid year
 * would otherwise forfeit ten months with nothing recorded anywhere. The balance sits on the
 * Stripe customer, where support can refund it from the dashboard; nothing is refunded
 * automatically.
 *
 * Idempotent: a subscription that is already `canceled` or does not exist answers `ok`.
 */
export async function cancelStripeSubscriptionNow(
  subscriptionId: string,
  opts?: { prorate?: boolean },
): Promise<StripeCancelOutcome> {
  const id = (subscriptionId ?? "").trim();
  if (!id) return { ok: true, already: true };
  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: "STRIPE_SECRET_KEY is unset; refusing to orphan a live subscription" };
  try {
    const current = await stripe.subscriptions.retrieve(id);
    if (current.status === "canceled") return { ok: true, already: true };
    await stripe.subscriptions.cancel(id, opts?.prorate ? { prorate: true } : undefined);
    return { ok: true, already: false };
  } catch (err) {
    if (isMissing(err)) return { ok: true, already: true };
    return { ok: false, error: errorText(err) };
  }
}

/**
 * Stop the subscription at the end of the current period. Used when the owner has asked to leave
 * but the data stays for a grace period: what is already paid for keeps working, and nothing new
 * is charged. Reversible from the billing portal or `POST /api/stripe/subscription/resume` until
 * the period ends.
 *
 * Idempotent: an already-scheduled or already-canceled subscription answers `ok`.
 */
export async function scheduleStripeCancelAtPeriodEnd(subscriptionId: string): Promise<StripeCancelOutcome> {
  const id = (subscriptionId ?? "").trim();
  if (!id) return { ok: true, already: true };
  const stripe = stripeClient();
  if (!stripe) return { ok: false, error: "STRIPE_SECRET_KEY is unset; refusing to orphan a live subscription" };
  try {
    const current = await stripe.subscriptions.retrieve(id);
    if (current.status === "canceled") return { ok: true, already: true };
    if (current.cancel_at_period_end || current.cancel_at) return { ok: true, already: true };
    await stripe.subscriptions.update(id, { cancel_at_period_end: true });
    return { ok: true, already: false };
  } catch (err) {
    if (isMissing(err)) return { ok: true, already: true };
    return { ok: false, error: errorText(err) };
  }
}
