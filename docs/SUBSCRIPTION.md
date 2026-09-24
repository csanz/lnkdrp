# Subscriptions (Stripe Checkout + webhooks)

This app implements **workspace-bound** subscriptions using **Stripe Checkout** and **webhooks** (webhook-driven access control; never trust redirects).

## Environment variables

Server (required):
- `STRIPE_SECRET_KEY` — Stripe secret key (test/live).
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret (`whsec_...` from Stripe CLI or Dashboard).
- `STRIPE_PRICE_ID` — recurring price id (`price_...`) for the Pro plan, monthly.
- `STRIPE_PRICE_ID_ANNUAL` — recurring price id for the Pro plan, yearly ($290, twelve months for the price of ten). Optional: unset means monthly only. Checkout with `{ interval: "year" }` uses it alone (no metered item; Stripe refuses the mix), so annual workspaces have no on-demand usage and may buy credit packs instead (`creditPacksAllowed`, `onDemandEligible` in `src/lib/billing/subscriptionState.ts`). The webhook stores `interval` on the subscription row from the licensed item's `recurring.interval`.
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
- Returns **409** (`code: "SUBSCRIPTION_ALREADY_ACTIVE"`, with a `portalUrl` hint and a same-origin `redirectTo` to the Billing tab) when the workspace already has a subscription Stripe has not finished with: `active`/`trialing`, and also `past_due`/`unpaid`/`incomplete`/`paused` (`hasOpenSubscription` in `src/lib/billing/subscriptionState.ts`). A workspace whose card is failing is Free meanwhile, but starting a second Checkout would stack a second subscription on the same customer; the fix is the portal's payment-method flow.
- There is no static Payment Link: the Checkout Session is minted per request by this route.

2) Stripe redirects to `/billing/success`
- UI shows “Processing…” and polls `GET /api/billing/status` until webhooks update MongoDB.

3) Webhooks update MongoDB (source of truth)
- `POST /api/stripe/webhook` verifies signature and updates the workspace subscription record.
- Webhooks persist Stripe billing-cycle boundaries onto the workspace subscription record:
  - `stripeSubscriptionId`, `stripeCustomerId`
  - `currentPeriodStart`, `currentPeriodEnd`
- For portal cancellation schedules, Stripe may send `cancel_at` (timestamp). We treat `cancel_at` as “Cancels on <date>” and persist it into the workspace subscription period end.
- Webhook idempotency is enforced via a tiny `StripeEvent` collection (unique Stripe `event.id`): the row is inserted **before** processing and `processedAt` is set **after**. A retry for an event with `processedAt=null` (previous attempt failed → 400) is processed again; a retry for a processed event is ACKed with no side effects.
- Ordering: every subscription write carries `lastStripeEventAt` and refuses an event older than the row's stamp. A stale event is ACKed and ignored (the upsert used to collide with the unique `{orgId}` index and answer 400, which made Stripe retry the same stale event for three days).
- One subscription per workspace: while the row's `stripeSubscriptionId` is still open in Stripe, `customer.subscription.*` events for a *different* subscription id carrying the same `metadata.orgId` are ignored. A finished subscription (`free`/`canceled`) leaves the row free for its replacement, which is the resubscribe case.
- Free daily brake: when a subscription stops being billable (`past_due`, `unpaid`, `deleted`), `WorkspaceCreditBalance.dailyCreditCap` is set back to `FREE_DAILY_CREDIT_CAP` unless the workspace holds purchased credits (a pack lifts the cap for good, so a lapsed yearly Pro that bought packs keeps it lifted). A subscription that recovers to `active` inside the same cycle has the cap lifted again, since the idempotent cycle grant would not.
- Yearly: when the licensed item's interval is `year`, the webhook nulls `stripeSubscriptionItemId` and turns `onDemandEnabled` off, and the credit service's default eligibility check (`defaultIsProWorkspace` in `serviceCore.ts`) answers `onDemandEligible`, not `isProSubscription`. A row switched to yearly in the Stripe dashboard therefore stops allocating on-demand credits that no metered item would bill.
- These guards are pinned by `tests/lib/stripeWebhook.test.ts`.

## Cancelling from inside the product

`src/lib/billing/stripeSubscriptionCancel.ts` is the one place the app cancels a subscription itself; both callers refuse their own action when Stripe cannot be reached rather than orphan a live subscription.

- `DELETE /api/orgs/:orgId` (team workspace) cancels the workspace's subscription **immediately** before soft-deleting anything, then marks the `Subscription` row deleted and turns on-demand off. On a yearly subscription the cancel is **prorated**: Stripe credits the unused months to the customer's balance, where support can refund them from the dashboard (nothing is refunded automatically). A cancel failure answers 502 `STRIPE_CANCEL_FAILED` and deletes nothing.
- `POST /api/account/delete` sets `cancel_at_period_end` on every subscription in a workspace the person owns alone **or** owns with others but where no other owner/admin exists (nobody left could open the portal). What is already paid for keeps working until the period ends, on yearly too. The purge skips any subscription already set to end at period end, so a prepaid year is never hard-cancelled; it only hard-cancels a solo workspace's subscription that somehow still bills. Where another owner/admin remains, the subscription is left alone and the workspace gets a `plan.subscription_ending` row telling them to replace the payment method (the card on the Stripe customer is the leaver's). Reversible from the portal or `POST /api/stripe/subscription/resume` until the period ends; note there is no undo for the deletion request itself.
- `customer.subscription.deleted` and `invoice.payment_failed` also set `WorkspaceCreditBalance.onDemandEnabled=false` (no overage on a dead/failing subscription).
- Stripe API `2025-12-15.clover` (stripe@20): billing periods are read from subscription **items** (`items.data[0].current_period_start/end`) and the invoice's subscription from `invoice.parent.subscription_details.subscription`, via `src/lib/billing/stripePeriods.ts` (`getSubscriptionPeriod`, `getInvoiceSubscriptionId`).
- Debug logging is available via `DEBUG_LEVEL=2` (logs safe subsets of payload fields + update outcomes).

## Credits (Stripe billing cycle)

- Pro includes **500 credits per billing cycle** (subscription anniversary, not calendar month).
- Cycle key for idempotent “reset/grant”:
  - `cycleKey = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
- On a new cycle, the system resets included credits to `INCLUDED_CREDITS_PER_CYCLE` (**500**, no rollover) and records a ledger entry keyed by `cycleKey`.
- Links, uploads, replacements and stats never need credits. Credits pay for AI runs: the automatic AI summary costs **1 credit** per upload (basic; standard 2, advanced 5), and AI compare on replacement costs **2 / 5 / 12** by tier (Basic on Free, Standard on Pro by default). The owner's version history and AI compare work on every plan and are limited only by credits; letting recipients browse versions on the share page is Pro.
- The summary costs **0 credits** when the uploader's own agent writes it (MCP `share_pdf` with summary and key points, or the API) and for files recipients upload through a request or replace link.
- Personal Free workspaces get **100 credits to start, once** (no monthly top-up since 2026-09-16), with at most **15 credits per day**. Team workspaces on Free get no allowance.
- **On-demand credits at $0.10 each, under a spend limit the owner sets, are Pro only** (retired for Free on 2026-09-17). A Free workspace that runs out buys a credit pack instead. Both gates enforce it: `POST /api/stripe/checkout { plan: "payg" }` answers 400 `PAYG_RETIRED`, and `POST /api/billing/spend` answers 403 for any limit above zero without Pro (turning the limit *down* to 0 is always allowed, so nobody is trapped). Legacy `Subscription.kind = "payg"` rows are still understood by the webhook, but `isProSubscription` is false for them, so they do not grant on-demand either.
- Out of credits: the upload still completes and the link works; the AI summary is skipped and the owner can write it later from the document page (1 credit). Compare and manual AI actions stop until the workspace adds credits (a credit pack, or Pro) or, on Pro, the cycle resets.
- Pricing change, effective **2026-09-13**: the automatic AI summary costs 1 credit (previously included). Starter credits already granted are kept in full. Noted in Terms section 8 and on `/pricing`.
- Pricing change, effective **2026-09-16**: the Free monthly floor (`FREE_MONTHLY_FLOOR_CREDITS`) is removed; the 100 starter credits are one-time. On-demand credits, previously Pro-only, are available to any personal Free workspace that adds a card.

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
- `src/components/BrandHeader.tsx` — the shared top bar (logo left, page controls right) for share pages and standalone flow pages.



## Stripe catalog ids

**Sandbox** (account "LinkDrop Sandbox", `acct_1SkZoiBxWJYhcWkZ`, configured 2026-09-12):

| Object | Id | Notes |
|---|---|---|
| Product Pro | `prod_Thzz8ih0J5i8W1` | metadata `type=pro`; no unit label |
| Price Pro $29/month (licensed) | `price_1SkZzUBxWJYhcWkZQTSQBzyG` | `STRIPE_PRICE_ID` |
| Price Pro $290/year (licensed, "Pro annual (2 months free)", lookup key `pro_annual`) | `price_1UJ4gXBxWJYhcWkZCk8GKuo9` | `STRIPE_PRICE_ID_ANNUAL` |
| Product On-demand AI credits | `prod_VFYHmHCuaZeApP` | unit label `credit`, metadata `type=ai_credits` |
| Price $0.10 per credit (metered, monthly) | `price_1UF3AYBxWJYhcWkZplMvZOi8` | `STRIPE_AI_CREDITS_PRICE_ID` |
| Billing Meter `ai_credits` | `mtr_test_61VOR6JFQe5B7caqU41BxWJYhcWkZN56` | sum, customer by `stripe_customer_id`, value key `value` |
| Archived | `price_1SllDeBxWJYhcWkZN1SZhtpy`, `price_1UF38xBxWJYhcWkZFaR9qvwQ` | old $0.01 price (wrong unit, wrong meter) and the first $0.10 price that lived on the Pro product (doubled the Checkout description) |

**Live:** not created yet. Recreate the same shape with the live key (see `DEPLOY.md` §4.2) and record the ids here.
