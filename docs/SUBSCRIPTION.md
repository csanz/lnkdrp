# Subscriptions (Stripe Checkout + webhooks)

This app implements **workspace-bound** subscriptions using **Stripe Checkout** and **webhooks** (webhook-driven access control; never trust redirects).

## Environment variables

Server (required):
- `STRIPE_SECRET_KEY` — Stripe secret key (test/live).
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (`whsec_...` from Stripe CLI or Dashboard).
- `STRIPE_PRICE_ID` — recurring price id (`price_...`) for the Pro plan.
- `STRIPE_AI_CREDITS_PRICE_ID` — metered price id (`price_...`) used to bill **AI credits** (usage records are reported in credits only).

Redirect URLs (optional overrides; otherwise derived from `NEXT_PUBLIC_APP_URL`):
- `STRIPE_SUCCESS_URL` — e.g. `https://your-domain/billing/success?session_id={CHECKOUT_SESSION_ID}`
- `STRIPE_CANCEL_URL` — e.g. `https://your-domain/billing/cancel`

App URL:
- `NEXT_PUBLIC_APP_URL` — canonical app URL used for redirects (e.g. `http://localhost:3001` or your tunnel URL).
- `NEXTAUTH_URL` — must match the domain you’re using in the browser when testing through a tunnel.

Debug (optional):
- `DEBUG_LEVEL=2` — enables verbose Stripe webhook logs (safe subset of payload fields).

Public (optional, pricing-table embed component only):
- `NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

## Stripe flow (workspace-bound)

1) **Upgrade** button calls `POST /api/stripe/checkout`
- Creates/reuses a Stripe customer stored on the workspace subscription record (`SubscriptionModel` for the active org).
- Creates a Stripe Checkout Session (`mode=subscription`) with `metadata.orgId` and `subscription_data.metadata.orgId`.

2) Stripe redirects to `/billing/success`
- UI shows “Processing…” and polls `GET /api/billing/status` until webhooks update MongoDB.

3) Webhooks update MongoDB (source of truth)
- `POST /api/stripe/webhook` verifies signature and updates the workspace subscription record.
- Webhooks persist Stripe billing-cycle boundaries onto the workspace subscription record:
  - `stripeSubscriptionId`, `stripeCustomerId`
  - `currentPeriodStart`, `currentPeriodEnd`
- For portal cancellation schedules, Stripe may send `cancel_at` (timestamp). We treat `cancel_at` as “Cancels on <date>” and persist it into the workspace subscription period end.
- Webhook idempotency is enforced via a tiny `StripeEvent` collection (unique Stripe `event.id`).
- Debug logging is available via `DEBUG_LEVEL=2` (logs safe subsets of payload fields + update outcomes).

## Credits (Stripe billing cycle)

- Pro includes **300 credits per billing cycle** (subscription anniversary, not calendar month).
- Cycle key for idempotent “reset/grant”:
  - `cycleKey = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
- On a new cycle, the system resets included credits to **300** (no rollover) and records a ledger entry keyed by `cycleKey`.

## Stripe usage reporting (metered credits)

- The system reports usage to Stripe as **credits** (no tokens/cost exposed in customer UI).
- Reporting is batched and idempotent via a cron backstop endpoint:
  - `POST /api/cron/stripe-credits-report`

## Local testing (Stripe CLI)

1) Start the app:

```bash
npm run dev
```

2) Forward webhooks (keep running):

```bash
stripe login
stripe listen --forward-to localhost:3001/api/stripe/webhook
```

3) Upgrade:
- Visit `/dashboard?tab=overview`
- Click **Upgrade**
- Pay with test card `4242 4242 4242 4242`
- Verify `/api/billing/status` returns `plan: "pro"`

4) Cancel / resume:
- Click **Manage subscription** (billing portal)
- Cancel / resume and watch the webhook logs
- Verify dashboard shows **Cancels on <date>** and then **Renews on <date>**

## Key files/routes

Routes:
- `src/app/api/stripe/checkout/route.ts` — creates Checkout Session (subscription).
- `src/app/api/stripe/webhook/route.ts` — webhook handler (signature verified; updates workspace subscription).
- `src/app/api/stripe/portal/route.ts` — billing portal session for the active workspace customer.
- `src/app/api/billing/status/route.ts` — active workspace billing status used by UI polling and dashboard (also returns Pro price label best-effort).

Pages:
- `src/app/billing/success/page.tsx` + `src/app/billing/success/successClient.tsx`
- `src/app/billing/cancel/page.tsx`

Models:
- `src/lib/models/Subscription.ts` — **workspace-bound** subscription state (Stripe ids + cancel/period info).
- `src/lib/models/StripeEvent.ts` — webhook idempotency (unique Stripe `event.id`).

UI:
- `src/app/dashboard/SubscriptionCard.tsx` — Upgrade + Manage Subscription UI; shows monthly cost next to Pro, and “Cancels on …” / “Renews on …”.
- `src/components/StandaloneBrandedHeader.tsx` — shared branding header for standalone flow pages.


