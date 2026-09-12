/**
 * API route for `/api/billing/subscription` — returns current org subscription status for the dashboard.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveActor, tryResolveUserActorFast } from "@/lib/gating/actor";
import { SubscriptionModel } from "@/lib/models/Subscription";

export const runtime = "nodejs";

function appUrlFromRequest(request: Request): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/**
 * Resolve the Checkout endpoint the client should POST to (`/api/stripe/checkout`).
 *
 * Returns `checkoutUrl: null` plus a clear `checkoutError` when Stripe is not configured, so the UI
 * can disable the Upgrade button instead of sending users to a broken/static link.
 */
function checkoutEndpoint(request: Request): { checkoutUrl: string | null; checkoutError: string | null } {
  const missing = ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"].filter((name) => !(process.env[name] ?? "").trim());
  if (missing.length) {
    return { checkoutUrl: null, checkoutError: `Stripe is not configured (missing ${missing.join(", ")})` };
  }
  return { checkoutUrl: `${appUrlFromRequest(request)}/api/stripe/checkout`, checkoutError: null };
}

export async function GET(request: Request) {
  // Hot path (dashboard): prefer fast resolver (cookie/JWT + single membership check).
  const actor = (await tryResolveUserActorFast(request)) ?? (await resolveActor(request));
  try {
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Types.ObjectId.isValid(actor.orgId)) {
      return NextResponse.json({ error: "Invalid org" }, { status: 400 });
    }
    const orgId = new Types.ObjectId(actor.orgId);

    await connectMongo();

    const sub = await SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
      .select({
        status: 1,
        planName: 1,
        currentPeriodEnd: 1,
        cancelAtPeriodEnd: 1,
        stripeCustomerId: 1,
      })
      .lean();

    const statusRaw = typeof (sub as any)?.status === "string" ? String((sub as any).status).trim() : "";
    const status = statusRaw || "free";

    const planNameRaw = typeof (sub as any)?.planName === "string" ? String((sub as any).planName).trim() : "";
    const planName = planNameRaw || (status === "free" ? "Free" : "Paid");

    // Checkout is always driven through our own route (which creates a per-workspace Checkout
    // Session with metadata/orgId); never hand out a static Payment Link.
    const { checkoutUrl, checkoutError } = checkoutEndpoint(request);

    return NextResponse.json({
      ok: true,
      subscription: {
        status,
        planName,
        currentPeriodEnd: (sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toISOString() : null,
        cancelAtPeriodEnd: Boolean((sub as any)?.cancelAtPeriodEnd),
        canManage: Boolean((sub as any)?.stripeCustomerId),
      },
      /** POST here to obtain a Stripe Checkout Session URL (`{ url }`); `null` when Stripe is not configured. */
      checkoutUrl,
      checkoutError,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


