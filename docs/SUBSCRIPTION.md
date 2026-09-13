# Subscriptions (Stripe Checkout + webhooks)

This app implements **workspace-bound** subscriptions using **Stripe Checkout** and **webhooks** (webhook-driven access control; never trust redirects).

## Environment variables

Server (required):
- `STRIPE_SECRET_KEY` — Stripe secret key (test/live).
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (`whsec_...` from Stripe CLI or Dashboard).
- `STRIPE_PRICE_ID` — recurring price id (`price_...`) for the Pro plan.
- `STRIPE_AI_CREDITS_PRICE_ID` — metered price id (`price_...`) used to bill **AI credits** (usage is reported in credits only). Canonical name; `STRIPE_USAGE_PRICE_ID` is accepted as a legacy alias (resolved by `getAiCreditsPriceId()` in `src/lib/credits/stripeReporting.ts`). Added automatically as a second, quantity-less line item on Checkout.
- `STRIPE_CREDITS_METER_EVENT_NAME` — Billing Meter `event_name` the metered price is attached to (default `ai_credits`). Optional.

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
- Line items: `STRIPE_PRICE_ID` (qty 1) plus `STRIPE_AI_CREDITS_PRICE_ID` (metered; no quantity) when configured.
- Returns **409** (`code: "SUBSCRIPTION_ALREADY_ACTIVE"`, with a `portalUrl` hint) when the workspace already has an `active`/`trialing` subscription — use the billing portal instead.
- `GET /api/billing/subscription` returns `checkoutUrl` pointing at this route (or `null` + `checkoutError` when Stripe is not configured); there is no static Payment Link.

2) Stripe redirects to `/billing/success`
- UI shows “Processing…” and polls `GET /api/billing/status` until webhooks update MongoDB.

3) Webhooks update MongoDB (source of truth)
- `POST /api/stripe/webhook` verifies signature and updates the workspace subscription record.
- Webhooks persist Stripe billing-cycle boundaries onto the workspace subscription record:
  - `stripeSubscriptionId`, `stripeCustomerId`
  - `currentPeriodStart`, `currentPeriodEnd`
- For portal cancellation schedules, Stripe may send `cancel_at` (timestamp). We treat `cancel_at` as “Cancels on <date>” and persist it into the workspace subscription period end.
- Webhook idempotency is enforced via a tiny `StripeEvent` collection (unique Stripe `event.id`): the row is inserted **before** processing and `processedAt` is set **after**. A retry for an event with `processedAt=null` (previous attempt failed → 400) is processed again; a retry for a processed event is ACKed with no side effects.
- `customer.subscription.deleted` and `invoice.payment_failed` also set `WorkspaceCreditBalance.onDemandEnabled=false` (no overage on a dead/failing subscription).
- Stripe API `2025-12-15.clover` (stripe@20): billing periods are read from subscription **items** (`items.data[0].current_period_start/end`) and the invoice's subscription from `invoice.parent.subscription_details.subscription`, via `src/lib/billing/stripePeriods.ts` (`getSubscriptionPeriod`, `getInvoiceSubscriptionId`).
- Debug logging is available via `DEBUG_LEVEL=2` (logs safe subsets of payload fields + update outcomes).

## Credits (Stripe billing cycle)

- Pro includes **300 credits per billing cycle** (subscription anniversary, not calendar month).
- Cycle key for idempotent “reset/grant”:
  - `cycleKey = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
- On a new cycle, the system resets included credits to **300** (no rollover) and records a ledger entry keyed by `cycleKey`.
- Links, uploads, replacements and stats never need credits. Credits pay for AI runs: the automatic AI summary costs **1 credit** per upload (basic; standard 2, advanced 5), and AI compare on replacement costs **2 / 5 / 12** by tier (Basic on Free, Standard on Pro by default; version history and AI compare are Pro).
- The summary costs **0 credits** when the uploader's own agent writes it (MCP `share_pdf` with summary and key points, or the API) and for files recipients upload through a request or replace link.
- Personal Free workspaces get **50 credits to start**, then a top-up to **10 on the 1st of each month** (a floor: a balance above 10 gets nothing; never additive), with at most **15 credits per day**. Team workspaces on Free get no allowance. No on-demand credits on Free.
- Pro can turn on optional **on-demand credits at $0.10 each** under a spend limit the owner sets.
- Out of credits: the upload still completes and the link works; the AI summary is skipped and the owner can write it later from the document page (1 credit). Compare and manual AI actions stop until credits return.
- Pricing change, effective **2026-09-13**: the automatic AI summary costs 1 credit (previously included). Starter credits already granted are kept in full. Noted in Terms section 8 and on `/pricing`.

## Stripe usage reporting (metered credits)

- The system reports usage to Stripe as **credits** (no tokens/cost exposed in customer UI).
- Only **on-demand/overage** credits are reported; on-demand requires the workspace toggle, a positive monthly limit, and an `active`/`trialing` subscription.
- Reporting uses **Billing Meter events** (`stripe.billing.meterEvents.create`) — `subscriptionItems.createUsageRecord` no longer exists in this API version:
  - `event_name`: `STRIPE_CREDITS_METER_EVENT_NAME` (default `ai_credits`)
  - `payload`: `{ stripe_customer_id, value: "<credits>" }`
  - `identifier`: deterministic batch id (Stripe de-duplicates within 24h)
- Dashboard setup: create a Billing Meter with that `event_name` (sum of `value`) and attach it to `STRIPE_AI_CREDITS_PRICE_ID`.
- Reporting is batched and crash-safe via a cron backstop endpoint (`POST /api/cron/stripe-credits-report`):
  1. **Claim** eligible ledger rows (`status=charged`, `eventType=ai_run`, `stripeUsageReportedAt=null`, unclaimed or claim older than 30 min): `$set { reportBatchId, reportClaimedAt }`
  2. **Report** one meter event per Stripe customer with `identifier = reportBatchId`
  3. **Mark** `stripeUsageReportedAt` on the claimed rows

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



## Stripe catalog ids

**Sandbox** (account "LinkDrop Sandbox", `acct_1SkZoiBxWJYhcWkZ`, configured 2026-09-12):

| Object | Id | Notes |
|---|---|---|
| Product Pro | `prod_Thzz8ih0J5i8W1` | metadata `type=pro`; no unit label |
| Price Pro $29/month (licensed) | `price_1SkZzUBxWJYhcWkZQTSQBzyG` | `STRIPE_PRICE_ID` |
| Product On-demand AI credits | `prod_VFYHmHCuaZeApP` | unit label `credit`, metadata `type=ai_credits` |
| Price $0.10 per credit (metered, monthly) | `price_1UF3AYBxWJYhcWkZplMvZOi8` | `STRIPE_AI_CREDITS_PRICE_ID` |
| Billing Meter `ai_credits` | `mtr_test_61VOR6JFQe5B7caqU41BxWJYhcWkZN56` | sum, customer by `stripe_customer_id`, value key `value` |
| Archived | `price_1SllDeBxWJYhcWkZN1SZhtpy`, `price_1UF38xBxWJYhcWkZFaR9qvwQ` | old $0.01 price (wrong unit, wrong meter) and the first $0.10 price that lived on the Pro product (doubled the Checkout description) |

**Live:** not created yet. Recreate the same shape with the live key (see `DEPLOY.md` §4.2) and record the ids here.
