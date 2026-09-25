/**
 * The Stripe customer behind a workspace. Billing is per workspace: each org has its own customer,
 * subscription, credits and invoices (`Subscription.stripeCustomerId`, one row per `orgId`), so one
 * person paying for two workspaces has two customers under the same email.
 *
 * The customer is named after the workspace. Unnamed, those customers were indistinguishable in
 * receipts, the billing portal and the Stripe dashboard: every one read as the owner's email.
 */
import type Stripe from "stripe";
import type { Types } from "mongoose";

import { OrgModel } from "@/lib/models/Org";
import { SubscriptionModel } from "@/lib/models/Subscription";

export type WorkspaceCustomer = { customerId: string; workspaceName: string };

/** Returns the workspace's Stripe customer, creating it (named after the workspace) the first time. */
export async function ensureWorkspaceStripeCustomer(params: {
  stripe: Stripe;
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  email: string | null | undefined;
}): Promise<WorkspaceCustomer> {
  const { stripe, orgId, userId } = params;
  const [org, sub] = await Promise.all([
    OrgModel.findOne({ _id: orgId }).select({ name: 1, type: 1 }).lean() as Promise<{ name?: string; type?: string } | null>,
    SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } }).select({ stripeCustomerId: 1 }).lean() as Promise<{
      stripeCustomerId?: string | null;
    } | null>,
  ]);
  const isTeam = org?.type === "team";
  // Personal workspaces are all named "Personal", which reads oddly as a bill-to name on its own.
  const workspaceName = isTeam ? (org?.name ?? "").trim() || "Team workspace" : "Personal workspace";
  const metadata = { userId: String(userId), orgId: String(orgId), orgType: isTeam ? "team" : "personal" };

  const existing = typeof sub?.stripeCustomerId === "string" ? sub.stripeCustomerId.trim() : "";
  if (existing) {
    // Customers created before they were named, or a workspace renamed since: keep the name current.
    // Best-effort, a stale name must not block a payment.
    try {
      await stripe.customers.update(existing, { name: workspaceName, metadata });
    } catch {
      // ignore
    }
    return { customerId: existing, workspaceName };
  }

  const email = (params.email ?? "").trim();
  /**
   * Idempotent on the workspace: two checkouts started together used to create two customers and
   * the second write won, leaving the first customer (and any card saved to it) orphaned in Stripe.
   * With the key, Stripe returns the same customer for the same workspace for 24 hours, so the
   * race collapses to one row. The Subscription row is matched on the live row only: a deleted
   * workspace's old row must not be revived with a fresh customer id.
   */
  const customer = await stripe.customers.create(
    { name: workspaceName, email: email || undefined, metadata },
    { idempotencyKey: `workspace-customer:${String(orgId)}` },
  );
  await SubscriptionModel.updateOne(
    { orgId, isDeleted: { $ne: true } },
    { $setOnInsert: { orgId, isDeleted: false }, $set: { stripeCustomerId: customer.id } },
    { upsert: true },
  );
  return { customerId: customer.id, workspaceName };
}
