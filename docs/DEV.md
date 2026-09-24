# Development Guide

This guide helps you get the LinkDrop development environment up and running.

## Prerequisites

- **Node.js** 20+ (recommend using [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm))
- **npm** (comes with Node.js)
- **MongoDB** (local instance or MongoDB Atlas)
- **Stripe CLI** (for webhook testing)
- **ngrok** (optional, for external webhook testing)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template and fill in values
cp .env.example .env.local   # (create .env.example first if needed)

# 3. Start the development server
npm run dev
```

The app runs on **http://localhost:3001** by default.

---

## Environment Variables

Create a `.env.local` file in the project root. Here's a complete reference:

### Required (Core)

```bash
# MongoDB
MONGODB_URI=mongodb://localhost:27017/lnkdrp
MONGODB_DB_NAME=lnkdrp                          # Optional, defaults to URI database

# Auth (Google OAuth + NextAuth)
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
NEXTAUTH_SECRET=your-random-secret-string       # Generate with: openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3001              # Must match your browser URL

# Vercel Blob (file storage)
BLOB_READ_WRITE_TOKEN=your-vercel-blob-token
# Optional: public base URL of *your* Blob store (https://<storeId>.public.blob.vercel-storage.com).
# Used to verify client-reported blob URLs belong to our store. When unset, the store id is derived
# from BLOB_READ_WRITE_TOKEN; if neither identifies the store, production rejects all blob URLs.
BLOB_BASE_URL=https://your-store-id.public.blob.vercel-storage.com
```

### Stripe (Billing)

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...                 # From Stripe CLI or Dashboard
STRIPE_PRICE_ID=price_...                       # Pro plan recurring price, monthly
STRIPE_PRICE_ID_ANNUAL=price_...                # Pro plan recurring price, yearly (optional; unset = monthly only)
STRIPE_AI_CREDITS_PRICE_ID=price_...            # Metered price for AI credits (canonical name)
# STRIPE_USAGE_PRICE_ID=price_...               # Legacy alias for STRIPE_AI_CREDITS_PRICE_ID (still honoured; prefer the canonical name)
STRIPE_CREDITS_METER_EVENT_NAME=ai_credits      # Billing Meter event_name attached to the metered price (default: ai_credits)

# Optional Stripe overrides
STRIPE_SUCCESS_URL=http://localhost:3001/billing/success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=http://localhost:3001/billing/cancel
```

### AI Features (OpenAI)

```bash
OPENAI_API_KEY=sk-...                           # Required for AI extraction/review
```

### App URLs

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3001       # Canonical app URL
NEXT_PUBLIC_SITE_URL=http://localhost:3001      # Public site URL (for emails, OG tags)
# NEXT_PUBLIC_MCP_URL=http://localhost:8787/mcp  # MCP endpoint shown in /connect and /mcp guides (default: production; /connect falls back to this local URL on a dev server)
NEXT_PUBLIC_REALTIME_URL=ws://localhost:8788    # Realtime WebSocket server (npm run realtime); unset = polling only. See docs/REALTIME.md
REALTIME_PORT=8788                              # Port the realtime server listens on
# REALTIME_MONGODB_URI=mongodb+srv://…/lnkdrp_dev  # Realtime server only: a read-only credential on the same database (falls back to MONGODB_URI)
# REALTIME_SECRET=…                             # Ticket HMAC secret shared by the app and the realtime server (defaults to NEXTAUTH_SECRET)
LNKDRP_API_URL=http://localhost:3001            # MCP server (npm run mcp): base URL of the Next app it calls (default when NODE_ENV != production). See docs/MCP.md
MCP_PORT=8787                                   # Port the MCP server listens on
MCP_PUBLIC_URL=http://localhost:8787            # URL the MCP server advertises in /.well-known/oauth-protected-resource
# LNKDRP_API_KEY=lnk_…                          # Only for `npm run mcp -- --stdio`: the key the stdio server acts with (never commit it)
```

### Optional

```bash
# Debug logging (0-3, higher = more verbose)
DEBUG_LEVEL=1
NEXT_PUBLIC_DEBUG_LEVEL=1

# Cron job authentication
LNKDRP_CRON_SECRET=your-cron-secret

# Email (defaults to console logging in dev)
EMAIL_TRANSPORT=console                         # Use "console" for dev, omit for production
NOTIFICATION_EMAIL_FROM=noreply@lnkdrp.com

# Stripe Pricing Table (optional embed component)
NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID=prctbl_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...

# Testing bypass (development only!)
API_TEST_BYPASS_AUTH=1
API_TEST_USER_ID=<mongo-user-id>

# Feature flags
NEXT_PUBLIC_FEATURE_REQUESTS=1                  # Re-enables the "Requests" item in the app sidebar (hidden by default)

# Slack integration (optional; see docs/prds/lnkdrp-slack.md). Both required for "Add to Slack".
# SLACK_CLIENT_ID=
# SLACK_CLIENT_SECRET=
```

---

## Running the Development Server

```bash
npm run dev
```

This starts Next.js on **http://localhost:3001** with:
- Hot module replacement
- Webpack polling (optimized for network drives / Synology)
- Watch options that ignore noisy paths (`tmp/`, `.DS_Store`, etc.)

### Alternative ports

The dev script is hardcoded to port 3001. To change it temporarily:

```bash
PORT=3002 npm run dev
```

---

## Using ngrok (External Access / Webhooks)

ngrok creates a public tunnel to your local dev server—useful for:
- Testing Stripe webhooks from the actual Stripe dashboard
- Sharing your local dev with others
- Testing OAuth callbacks from external services

### Setup

```bash
# Install ngrok (macOS)
brew install ngrok

# Or download from https://ngrok.com/download

# Authenticate (one-time)
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

### Start the tunnel

```bash
# Terminal 1: Start your dev server
npm run dev

# Terminal 2: Start ngrok tunnel
ngrok http 3001
```

ngrok will display a URL like `https://abc123.ngrok.io`.

### Update environment for ngrok

When using ngrok, update your `.env.local`:

```bash
NEXT_PUBLIC_APP_URL=https://abc123.ngrok.io
NEXT_PUBLIC_SITE_URL=https://abc123.ngrok.io
NEXTAUTH_URL=https://abc123.ngrok.io
```

**Important:** Also update your Google OAuth consent screen to include the ngrok URL as an authorized redirect URI:
- Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- Edit your OAuth 2.0 Client ID
- Add `https://abc123.ngrok.io/api/auth/callback/google` to Authorized redirect URIs

### ngrok with Stripe webhooks

If using ngrok for Stripe webhooks (instead of Stripe CLI):

1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Add endpoint: `https://abc123.ngrok.io/api/stripe/webhook`
3. Select events: `checkout.session.completed`, `customer.subscription.*`, `invoice.*`
4. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`

---

## Stripe Integration (Full Guide)

The app uses **Stripe Checkout** for subscriptions and **webhooks** as the source of truth for granting Pro access. Access is **webhook-driven**—never trust redirects.

### Architecture Overview

```
User clicks Upgrade → POST /api/stripe/checkout → Stripe Checkout
                                                        ↓
                                              User completes payment
                                                        ↓
/billing/success (polls status) ← Stripe webhook → POST /api/stripe/webhook
                                                        ↓
                                              Updates MongoDB (Subscription model)
                                                        ↓
                                              UI shows "Pro active"
```

### Environment Variables (Stripe)

```bash
# Required
STRIPE_SECRET_KEY=sk_test_...                   # Test or live secret key
STRIPE_WEBHOOK_SECRET=whsec_...                 # From Stripe CLI or Dashboard
STRIPE_PRICE_ID=price_...                       # Pro plan recurring price ID
STRIPE_AI_CREDITS_PRICE_ID=price_...            # Metered price for AI credits usage (canonical)
# STRIPE_USAGE_PRICE_ID=price_...               # Legacy alias; read only when STRIPE_AI_CREDITS_PRICE_ID is unset
STRIPE_CREDITS_METER_EVENT_NAME=ai_credits      # Billing Meter event_name for the metered price (default: ai_credits)

# Optional overrides (defaults derive from NEXT_PUBLIC_APP_URL)
STRIPE_SUCCESS_URL=http://localhost:3001/billing/success?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=http://localhost:3001/billing/cancel

# Optional (pricing table embed only)
NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID=prctbl_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

### Setup Stripe CLI (Recommended for Local)

```bash
# Install Stripe CLI (macOS)
brew install stripe/stripe-cli/stripe

# Login to your Stripe account
stripe login

# Verify connection
stripe config --list
```

### Forward Webhooks to Localhost

```bash
# Terminal 1: Start dev server
npm run dev

# Terminal 2: Forward Stripe webhooks (keep running)
stripe listen --forward-to localhost:3001/api/stripe/webhook
```

The CLI prints a webhook signing secret:
```
Ready! Your webhook signing secret is whsec_1234567890abcdef...
```

Copy this to `.env.local`:
```bash
STRIPE_WEBHOOK_SECRET=whsec_1234567890abcdef...
```

### Test the Full Subscription Flow

1. **Start fresh** (ensure webhook forwarding is running)

2. **Visit the dashboard**
   ```
   http://localhost:3001/dashboard?tab=overview
   ```

3. **Click Upgrade** → redirects to Stripe Checkout

4. **Use test card details:**
   - Card: `4242 4242 4242 4242`
   - Expiry: Any future date (e.g., `12/34`)
   - CVC: Any 3 digits (e.g., `123`)
   - ZIP: Any 5 digits (e.g., `12345`)

5. **Complete checkout** → redirects to `/billing/success`

6. **Watch the terminal** for webhook events:
   ```
   2024-01-15 10:30:00 --> checkout.session.completed [evt_xxx]
   2024-01-15 10:30:00 <-- [200] POST http://localhost:3001/api/stripe/webhook
   2024-01-15 10:30:01 --> customer.subscription.created [evt_xxx]
   2024-01-15 10:30:01 <-- [200] POST http://localhost:3001/api/stripe/webhook
   ```

7. **Verify Pro status:**
   ```bash
   curl http://localhost:3001/api/billing/status
   # Should return: { "plan": "pro", ... }
   ```

### Test Subscription Management

**Cancel subscription:**
1. Go to Dashboard → click **Manage Subscription**
2. In Stripe portal, click **Cancel plan**
3. Watch webhook: `customer.subscription.updated` with `cancel_at` set
4. Dashboard shows "Cancels on [date]"

**Resume subscription:**
1. Go to Dashboard → click **Manage Subscription**
2. In Stripe portal, click **Resume subscription**
3. Watch webhook: `customer.subscription.updated` with `cancel_at` cleared
4. Dashboard shows "Renews on [date]"

### Trigger Test Events Manually

```bash
# Checkout completed
stripe trigger checkout.session.completed

# Subscription events
stripe trigger customer.subscription.created
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted

# Invoice events (for metered billing)
stripe trigger invoice.created
stripe trigger invoice.paid
stripe trigger invoice.payment_failed

# List all available triggers
stripe trigger --help
```

### Test Cards Reference

| Scenario | Card Number |
|----------|-------------|
| Success | `4242 4242 4242 4242` |
| Requires authentication | `4000 0025 0000 3155` |
| Declined | `4000 0000 0000 0002` |
| Insufficient funds | `4000 0000 0000 9995` |
| Expired card | `4000 0000 0000 0069` |

### Webhook Events Handled

The app handles these Stripe webhook events:

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Create/update subscription, link to workspace |
| `customer.subscription.created` | Store subscription details |
| `customer.subscription.updated` | Update period dates, handle cancel/resume |
| `customer.subscription.deleted` | Mark subscription inactive; disable on-demand overage |
| `invoice.paid` | Confirm payment, trigger credit grants |
| `invoice.payment_failed` | Log failure; disable on-demand overage (access continues until period end) |

Webhook idempotency: a `StripeEvent` row (unique `eventId`) is inserted before processing and `processedAt` is set afterwards. A retry of an event whose first attempt failed (`processedAt=null`) is processed again; a retry of a processed event is ACKed without side effects.

Stripe API version note (stripe@20 → `2025-12-15.clover`): `current_period_start/end` live on **subscription items** and `invoice.subscription` moved to `invoice.parent.subscription_details.subscription`. Always read them via `getSubscriptionPeriod()` / `getInvoiceSubscriptionId()` from `src/lib/billing/stripePeriods.ts`.

### Key Stripe Routes

| Route | Purpose |
|-------|---------|
| `POST /api/stripe/checkout` | Create Checkout Session |
| `POST /api/stripe/webhook` | Handle Stripe webhooks |
| `POST /api/stripe/portal` | Create billing portal session |
| `GET /api/billing/status` | Current billing status (for UI polling) |

### Credits & Metered Billing

Pro includes **500 credits per billing cycle** (resets on subscription anniversary):

```
Cycle Key = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}
```

**How credits work:**
1. Webhook receives `invoice.paid` with new period dates
2. System generates `cycleKey` from subscription + period start
3. Idempotent grant of `INCLUDED_CREDITS_PER_CYCLE` (500) included credits (no duplicates)
4. On-demand usage is reported to Stripe via metered billing (Billing Meter events)

**On-demand (overage) rules:**
- Requires `onDemandEnabled=true` and a positive `onDemandMonthlyLimitCents` on the workspace balance **and** an `active`/`trialing` subscription (checked at reservation time).
- `customer.subscription.deleted` and `invoice.payment_failed` webhooks flip `onDemandEnabled=false`.

**Metered reporting (`/api/cron/stripe-credits-report`):**
- Checkout adds `STRIPE_AI_CREDITS_PRICE_ID` as a second (metered, no quantity) line item, so every Pro subscription carries the metered item.
- Usage is sent with `stripe.billing.meterEvents.create({ event_name: STRIPE_CREDITS_METER_EVENT_NAME, payload: { stripe_customer_id, value } })`. In the Stripe dashboard create a **Billing Meter** with that `event_name` (default `ai_credits`, sum aggregation) and attach it to the metered price.
- Claim-then-report: ledger rows are first stamped with `reportBatchId` + `reportClaimedAt`, then reported (batch id = meter event `identifier`, so Stripe de-duplicates retries), then `stripeUsageReportedAt` is set. Claims older than 30 minutes are treated as stale and re-claimed.

**Test credit grants:**
```bash
# Trigger the credits reconcile cron
curl -X POST http://localhost:3001/api/cron/credits-cycle-reconcile

# Check credits snapshot
curl http://localhost:3001/api/credits/snapshot
```

### Debug Stripe Issues

Enable verbose logging:
```bash
DEBUG_LEVEL=2
```

Check webhook delivery in Stripe Dashboard:
- [Test mode webhooks](https://dashboard.stripe.com/test/webhooks)
- [Live mode webhooks](https://dashboard.stripe.com/webhooks)

Common issues:
- **Webhook signature mismatch**: Ensure `STRIPE_WEBHOOK_SECRET` matches CLI output
- **Events not arriving**: Check `stripe listen` is running
- **Wrong endpoint**: Verify URL is `localhost:3001/api/stripe/webhook`

### Stripe CLI Commands Reference

The Stripe CLI is incredibly useful for local development. Here are all the commands you'll commonly use:

#### Account & Config

```bash
# Login to Stripe
stripe login

# Check current config
stripe config --list

# Switch between accounts (if you have multiple)
stripe login --interactive

# Check CLI version
stripe --version
```

#### Products & Prices

```bash
# List all prices (find your STRIPE_PRICE_ID)
stripe prices list --limit 10

# List prices with more details
stripe prices list --limit 10 --expand data.product

# Get a specific price
stripe prices retrieve price_xxx

# List all products
stripe products list --limit 10

# Get a specific product
stripe products retrieve prod_xxx

# Create a test product
stripe products create --name="Test Product" --description="For testing"

# Create a test price
stripe prices create \
  --product=prod_xxx \
  --unit-amount=1999 \
  --currency=usd \
  --recurring[interval]=month
```

#### Customers

```bash
# List customers
stripe customers list --limit 10

# Search for a customer by email
stripe customers list --email="user@example.com"

# Get a specific customer
stripe customers retrieve cus_xxx

# Create a test customer
stripe customers create --email="test@example.com" --name="Test User"

# Delete a test customer
stripe customers delete cus_xxx
```

#### Subscriptions

```bash
# List all subscriptions
stripe subscriptions list --limit 10

# List active subscriptions only
stripe subscriptions list --status=active --limit 10

# Get a specific subscription
stripe subscriptions retrieve sub_xxx

# Cancel a subscription immediately
stripe subscriptions cancel sub_xxx

# Cancel at period end
stripe subscriptions update sub_xxx --cancel-at-period-end=true

# Resume a canceled subscription
stripe subscriptions update sub_xxx --cancel-at-period-end=false
```

#### Invoices & Payments

```bash
# List recent invoices
stripe invoices list --limit 10

# Get a specific invoice
stripe invoices retrieve in_xxx

# List payment intents
stripe payment_intents list --limit 10

# List charges
stripe charges list --limit 10
```

#### Webhook Testing

```bash
# Forward all webhooks to localhost
stripe listen --forward-to localhost:3001/api/stripe/webhook

# Forward specific events only
stripe listen --forward-to localhost:3001/api/stripe/webhook \
  --events checkout.session.completed,customer.subscription.updated

# Print webhook events without forwarding (debugging)
stripe listen --print-json

# Resend a specific event from the dashboard
stripe events resend evt_xxx
```

#### Trigger Test Events

```bash
# Trigger checkout completed
stripe trigger checkout.session.completed

# Trigger subscription lifecycle
stripe trigger customer.subscription.created
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted

# Trigger payment events
stripe trigger payment_intent.succeeded
stripe trigger payment_intent.payment_failed

# Trigger invoice events
stripe trigger invoice.created
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
stripe trigger invoice.upcoming

# List all available triggers
stripe trigger --help
```

#### Usage Records (Metered Billing)

```bash
# Report usage for a subscription item
stripe subscription_items create_usage_record si_xxx \
  --quantity=100 \
  --timestamp=now

# List usage records
stripe subscription_items list_usage_record_summaries si_xxx
```

#### Logs & Events

```bash
# List recent events
stripe events list --limit 10

# Get a specific event
stripe events retrieve evt_xxx

# Tail logs in real-time
stripe logs tail

# Filter logs by status
stripe logs tail --filter-status-code-type=4XX
```

#### API Requests

```bash
# Make arbitrary API requests
stripe get /v1/balance

# POST request
stripe post /v1/customers -d email="test@example.com"

# With query params
stripe get /v1/customers -d limit=5
```

#### Helpful One-Liners

```bash
# Find your price IDs quickly
stripe prices list --limit 20 | grep -E "(id|nickname|unit_amount)"

# Get webhook signing secret for current session
stripe listen --print-secret

# Quick subscription check
stripe subscriptions list --limit 5 --expand data.customer

# Find customers by email domain
stripe customers search --query="email~'@yourcompany.com'"

# Export recent events to JSON
stripe events list --limit 100 > stripe-events.json
```

---

## Database

### Local MongoDB

```bash
# Install (macOS)
brew tap mongodb/brew
brew install mongodb-community

# Start MongoDB
brew services start mongodb-community

# Connection string for .env.local
MONGODB_URI=mongodb://localhost:27017/lnkdrp
```

### MongoDB Atlas (Cloud)

1. Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/atlas)
2. Get your connection string
3. Add to `.env.local`:

```bash
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/lnkdrp
```

### Migrations

Run database migrations:

```bash
# Run all pending migrations
node db/migration/run.mjs

# Migrations are in db/migration/ with timestamps
```

### Clear development data

Both commands refuse to run against anything but a database on this machine — see
`src/lib/db/localTarget.ts`. `mongodb+srv://` is never local, every host in a replica-set URI has to
be local (not just the first), and `NODE_ENV=production` or any `VERCEL` variable refuses outright.
There is deliberately no `--force`.

```bash
# Empty the database (DESTRUCTIVE). Stop the dev server first — an open tab
# re-creates your user and workspace seconds after the drop.
npm run reset

# See what is in there without changing anything
npm run reset -- --dry

# Scoped: clear only AI runs and request repos, keeping docs and uploads
npm run mongo:clear:ai-runs-requests -- --dry-run
npm run mongo:clear:ai-runs-requests -- --yes
```

---

## Running Tests

```bash
# Agent tests (CLI mode)
npm run tests:agent:cli

# Agent tests (Vitest)
npm run tests:agent:vitest

# Upload pipeline tests
npm run tests:upload:vitest

# Credits/billing tests
npm run tests:credits:vitest

# Route tests
npm run tests:routes

# Benchmark tests
npm run tests:benchmark
```

### Test environment

There is no `.env.test`: every vitest config sets `envDir: "./tmp"`, which deliberately points env
loading away from the repo root, so a file there is read by nothing.

The auth bypass the route tests use belongs on the **Next.js dev server process**, not on the test
runner — `scripts/tests-routes.mjs` says the same in its own usage text:

```bash
API_TEST_BYPASS_AUTH=1 API_TEST_USER_ID=<test-user-mongo-id> npm run dev
```

---

## NPM Scripts Reference

Every script in `package.json`, all 53 of them. The `:prod` variants differ from their siblings in
one thing only — `--env-file=.env.production.local` instead of `.env.local` — so they act on
production. Read the command column before running one.

### Core development

| Script | Command | Description |
|--------|---------|-------------|
| `npm run dev` | `next dev -p 3001` | Dev server with hot reload |
| `npm run dev:webpack` | `next dev --webpack -p 3001`, polling on | Same, for filesystems where watching does not fire (a network share) |
| `npm run build` | `next build` | Production build |
| `npm run start` | `next start -p 3001` | Serve a production build |
| `npm run lint` | `eslint` | Lint |
| `npm run index` | `node scripts/build-index.mjs` | Regenerate `INDEX.md`, the code map (`-- --check` to verify) |
| `npm run preflight:env` | `tsx scripts/preflight-env.ts` | Check the local env for what the app needs |
| `npm run preflight:env:prod` | same, against `.env.production.local` | Check production's env |

### The other two services

| Script | Command | Description |
|--------|---------|-------------|
| `npm run realtime` | `tsx realtime/server.ts` | WebSocket server on :8788 |
| `npm run realtime:prod` | `node --import tsx realtime/server.ts` | Same, no `.env.local` — the host supplies the env |
| `npm run mcp` | `tsx mcp/src/main.ts` | MCP server on :8787 |
| `npm run mcp:prod` | `node --import tsx mcp/src/main.ts` | Same, no `.env.local` |

### Database and data

| Script | Command | Description |
|--------|---------|-------------|
| `npm run reset` | `tsx scripts/reset-local.ts` | Empty the local database. Refuses anything but localhost; no `--force` |
| `npm run reset -- --dry` | | List what is in there, changing nothing |
| `npm run mongo:clear:ai-runs-requests` | `tsx scripts/mongo-clear-ai-runs-and-requests.ts` | Clear AI runs and request repos only; same guard |
| `npm run sharelinks:backfill` | `tsx scripts/sharelinks-backfill.ts` | Give pre-multi-link documents a share link row |
| `npm run sharelinks:analytics-backfill` | `tsx scripts/sharelinks-analytics-backfill.ts` | Attribute old analytics rows to their share link |
| `npm run audit:blob-urls` | `tsx scripts/audit-stored-blob-urls.ts` | Find stored blob URLs that no longer resolve |
| `npm run verify:analytics` | `tsx scripts/verify-share-analytics.ts` | Check a share's analytics against the raw rows |

### Admin and the waitlist

| Script | Command | Description |
|--------|---------|-------------|
| `npm run admin:list` | `tsx scripts/admin-add.ts --list` | Who can reach `/a` |
| `npm run admin:add -- --to=<email>` | `tsx scripts/admin-add.ts` | Make someone an admin |
| `npm run admin:list:prod` / `npm run admin:add:prod` | same, against `.env.production.local` | The production admin list |
| `npm run waitlist:invite -- --to=<email>` | `tsx scripts/waitlist-invite.ts` | Let someone out of the queue and mail them |
| `npm run waitlist:invite:prod -- --to=<email>` | same, against `.env.production.local` | The same, in production |

### Metrics and background jobs

| Script | Command | Description |
|--------|---------|-------------|
| `npm run metrics:rollup:once` | `tsx scripts/rollup-doc-metrics.ts --once` | Run the doc-metrics rollup once |
| `npm run metrics:rollup:dev` | `tsx scripts/rollup-doc-metrics.ts --interval 10000` | Run it every 10s |

### Cron jobs

One per scheduled job; each calls its route rather than re-implementing it. `scripts/cron/README.md`
is the table of schedules, and `tests/lib/cronMap.test.ts` keeps it honest. All take `--dry-run`,
`--limit=` and `--target=` where the route supports them.

| Script | Script |
|--------|--------|
| `npm run cron:doc-metrics` | `npm run cron:analytics-reconcile` |
| `npm run cron:stripe-credits-reconcile` | `npm run cron:credits-purchase-expiry` |
| `npm run cron:stripe-credits-report` | `npm run cron:credits-stale-reservations` |
| `npm run cron:credits-cycle-reconcile` | `npm run cron:account-purge` |
| `npm run cron:usage-agg-reconcile` | `npm run cron:notification-emails` |
| `npm run cron:plan-limits` | |

### Testing

| Script | Command | Description |
|--------|---------|-------------|
| `npm run tests:lib:vitest` | `vitest run --config tests/lib/vitest.config.ts` | The big one — ~219 files, and the suite that guards the cron map |
| `npm run tests:agent` / `:cli` | `tsx tests/agent/agent.cli.ts` | Agent tests, CLI mode |
| `npm run tests:agent:vitest` | `vitest run --config tests/agent/vitest.config.ts` | Agent tests |
| `npm run tests:upload:vitest` | `vitest run --config tests/upload/vitest.config.ts` | Upload pipeline |
| `npm run tests:credits:vitest` | `vitest run --config tests/credits/vitest.config.ts` | Credits and billing |
| `npm run tests:routes` | `node scripts/tests-routes.mjs` | Route tests (needs the dev server) |
| `npm run tests:benchmark` | `tsx scripts/tests-benchmark.ts` | Benchmarks |

Nothing runs any of these automatically: there is no CI workflow in this repo.

### One-off checks

| Script | Command | Description |
|--------|---------|-------------|
| `npm run test:pdf2png` | `node scripts/pdf-first-page-to-png.mjs` | PDF page to PNG |
| `npm run test:pdf2txt` | `node scripts/pdf-to-text.mjs` | PDF text extraction |
| `npm run test:ai-extract` | `tsx scripts/test-ai-extract.ts` | Run the real `analyzePdfText()` over a file |
| `npm run test:notification-emails` | `tsx scripts/notifications-send-emails.ts` | Notification emails, dry-run |
| `npm run test:emails` | `tsx scripts/send-test-emails.ts` | Send one of each template to yourself |
| `npm run test:account-deletion` | `tsx scripts/test-account-deletion.ts` | Walk the account-deletion flow |
| `npm run measure:image-tokens` | `tsx scripts/measure-image-tokens.ts` | Measure what an image really costs per model |
| `npm run blob:test` | `node scripts/test-vercel-blob.mjs` | Vercel Blob upload |

### Usage Examples

```bash
# Start dev server
npm run dev

# Run tests
npm run tests:credits:vitest

# Run metrics rollup once
npm run metrics:rollup:once

# Run metrics rollup for specific doc
npm run metrics:rollup:once -- --docId 507f1f77bcf86cd799439011

# Run metrics continuously with custom interval
npm run metrics:rollup:dev -- --interval 5000

# Run benchmark tests with custom params
LNKDRP_BASE_URL=http://localhost:3001 npm run tests:benchmark

# Test notification emails (dry-run)
npm run test:notification-emails

# Actually send notification emails
npm run test:notification-emails -- --send
```

---

## Cron Jobs (Full Guide)

The app uses background cron jobs for metrics rollups, credit grants, usage reporting, and notifications. In production, these run on Vercel Cron (configured in `vercel.json`). Locally, you trigger them manually.

### Cron Job Inventory

| Job | Route | Production Schedule | Purpose |
|-----|-------|---------------------|---------|
| Doc metrics | `/api/cron/doc-metrics` | Every 6 hours | Roll up share view metrics per doc |
| Credits cycle | `/api/cron/credits-cycle-reconcile` | Hourly | Ensure included credits granted for billing cycle |
| Stripe reconcile | `/api/cron/stripe-credits-reconcile` | Every 6 hours | Sync Stripe subscription periods + grant credits |
| Stripe report | `/api/cron/stripe-credits-report` | Hourly | Report metered on-demand credits to Stripe |
| Usage aggregates | `/api/cron/usage-agg-reconcile` | Hourly | Recompute daily/cycle usage totals |
| Notification emails | `/api/cron/notification-emails` | Every 5 min | Send doc update + request repo emails |

### Trigger Cron Jobs Locally

All cron routes accept POST requests:

```bash
# Doc metrics rollup (cache share view stats)
curl -X POST http://localhost:3001/api/cron/doc-metrics

# Credits cycle reconcile (ensure credits are granted)
curl -X POST http://localhost:3001/api/cron/credits-cycle-reconcile

# Stripe credits reconcile (sync periods from Stripe)
curl -X POST http://localhost:3001/api/cron/stripe-credits-reconcile

# Stripe credits report (report on-demand usage to Stripe)
curl -X POST http://localhost:3001/api/cron/stripe-credits-report

# Usage aggregates (recompute usage totals)
curl -X POST http://localhost:3001/api/cron/usage-agg-reconcile

# Notification emails (send pending notifications)
curl -X POST http://localhost:3001/api/cron/notification-emails
```

### Cron Authentication

If `CRON_SECRET` (or the legacy `LNKDRP_CRON_SECRET`) is set, include it in requests:

```bash
# Via Authorization header (recommended; what Vercel Cron sends)
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3001/api/cron/doc-metrics

# Or via the legacy header
curl -X POST \
  -H "x-cron-secret: $CRON_SECRET" \
  http://localhost:3001/api/cron/doc-metrics

# Or via query param (dev only; ignored in production, where URLs land in request logs)
curl -X POST "http://localhost:3001/api/cron/doc-metrics?secret=$CRON_SECRET"
```

The cron monitor (`GET /api/monitor/crons`) also accepts the read-only `CRON_MONITOR_SECRET`, which cannot trigger jobs. See `docs/CRON.md`.

### Cron Job Details

#### Doc Metrics Rollup

Computes cached metrics snapshots (views, downloads) so the doc UI loads fast.

```bash
# Run once
npm run metrics:rollup:once

# Run for a specific doc
npm run metrics:rollup:once -- --docId 507f1f77bcf86cd799439011

# Run continuously (every 10s, for dev background processing)
npm run metrics:rollup:dev

# Custom interval
npm run metrics:rollup:dev -- --interval 5000

# Via curl with params
curl -X POST "http://localhost:3001/api/cron/doc-metrics?days=15&limit=100"
curl -X POST "http://localhost:3001/api/cron/doc-metrics?docId=507f1f77bcf86cd799439011"
```

**Parameters:**
- `days` — Lookback window (default: 15, max: 60)
- `limit` — Max docs per run (default: 50, max: 500)
- `docId` — Process a single doc

#### Credits Cycle Reconcile

Hourly backstop ensuring Pro workspaces have their included credits for the current billing cycle.

```bash
curl -X POST http://localhost:3001/api/cron/credits-cycle-reconcile
```

**What it does:**
1. Finds active subscriptions
2. Checks if cycle grant exists for current period
3. Grants `INCLUDED_CREDITS_PER_CYCLE` (500) included credits if missing (idempotent)

#### Stripe Credits Reconcile

Heavier backstop that syncs subscription period dates from Stripe.

```bash
curl -X POST http://localhost:3001/api/cron/stripe-credits-reconcile
```

**What it does:**
1. Fetches subscription from Stripe API
2. Updates `currentPeriodStart` / `currentPeriodEnd` in MongoDB
3. Grants cycle credits if needed

#### Stripe Credits Report

Reports metered on-demand usage to Stripe for billing.

```bash
curl -X POST http://localhost:3001/api/cron/stripe-credits-report
```

**What it does:**
1. Finds unreported on-demand credits in CreditLedger
2. Reports usage to Stripe (with idempotency keys)
3. Marks ledger entries as reported

#### Usage Aggregates Reconcile

Recomputes pre-aggregated usage totals for dashboard display.

```bash
curl -X POST http://localhost:3001/api/cron/usage-agg-reconcile

# With date range
curl -X POST "http://localhost:3001/api/cron/usage-agg-reconcile?startDate=2024-01-01&endDate=2024-01-31"
```

**What it does:**
1. Reads CreditLedger entries
2. Computes daily totals → `UsageAggDaily`
3. Computes cycle totals → `UsageAggCycle`

#### Notification Emails

Sends doc update and request repo notification emails based on user preferences.

```bash
# Via cron endpoint
curl -X POST http://localhost:3001/api/cron/notification-emails

# Via npm script (dry-run by default)
npm run test:notification-emails

# Actually send (be careful!)
npm run test:notification-emails -- --send
```

**Email modes per workspace member:**
- `off` — No emails
- `daily` — Digest once per day
- `immediate` — Send as soon as events occur

### Monitor Cron Health

Check cron job status in the admin UI:

```
http://localhost:3001/a/cron-health
```

Or via API:

```bash
curl http://localhost:3001/api/admin/cron-health
```

Each job writes a `CronHealth` record with:
- `status`: `running`, `ok`, or `error`
- `lastRunAt`, `lastDurationMs`
- `lastError` (if failed)

### Production Schedule (vercel.json)

```json
{
  "crons": [
    { "path": "/api/cron/doc-metrics", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/stripe-credits-reconcile", "schedule": "15 */6 * * *" },
    { "path": "/api/cron/stripe-credits-report", "schedule": "30 * * * *" },
    { "path": "/api/cron/credits-cycle-reconcile", "schedule": "10 * * * *" },
    { "path": "/api/cron/usage-agg-reconcile", "schedule": "20 * * * *" },
    { "path": "/api/cron/notification-emails", "schedule": "*/5 * * * *" }
  ]
}
```

### Testing Cron Jobs End-to-End

```bash
# 1. Start dev server
npm run dev

# 2. In another terminal, trigger all crons in sequence
curl -X POST http://localhost:3001/api/cron/doc-metrics && \
curl -X POST http://localhost:3001/api/cron/credits-cycle-reconcile && \
curl -X POST http://localhost:3001/api/cron/usage-agg-reconcile && \
curl -X POST http://localhost:3001/api/cron/notification-emails

# 3. Check health
curl http://localhost:3001/api/admin/cron-health | jq
```

See `docs/CRON.md` for complete technical documentation.

---

## Build & Production Preview

```bash
# Build for production
npm run build

# Start production server locally
npm run start
```

---

## Project Structure

```
www_lnkdrp/
├── db/migration/          # Database migrations
├── docs/                  # Documentation (FEATURES.md, CRON.md, etc.)
├── public/                # Static assets
├── scripts/               # Utility scripts
├── src/
│   ├── app/               # Next.js App Router (pages + API routes)
│   ├── components/        # React components
│   ├── lib/               # Shared libraries (models, utils, AI)
│   └── types/             # TypeScript type definitions
├── tests/                 # Test suites
├── INDEX.md               # File map (keep updated!)
├── DEV.md                 # This file
└── package.json
```

### Key documentation files

- `INDEX.md` — File map with exports and routes
- `docs/FEATURES.md` — Product/feature documentation
- `docs/CRON.md` — Cron job documentation
- `docs/SUBSCRIPTION.md` — Stripe/billing documentation
- `docs/REQUEST.md` — Request link documentation

---

## Troubleshooting

### "Missing required env var" errors

Ensure all required env vars are in `.env.local`. Check the Environment Variables section above.

### MongoDB connection failures

- Verify MongoDB is running: `brew services list`
- Check `MONGODB_URI` format
- For Atlas: ensure your IP is whitelisted

### Google OAuth not working

- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- Check that `NEXTAUTH_URL` matches your browser URL exactly
- For ngrok: add the ngrok URL to authorized redirect URIs in Google Cloud Console

### Stripe webhooks not firing

- For Stripe CLI: ensure `stripe listen` is running
- Check `STRIPE_WEBHOOK_SECRET` matches the CLI output
- Verify the endpoint URL is correct

### Hot reload not working

The dev server uses polling for compatibility with network drives. If changes aren't detected:
- Check that the file is actually saved
- Try restarting the dev server
- Verify the file isn't in an ignored path (`tmp/`, `node_modules/`, etc.)

### AI features returning null

- Verify `OPENAI_API_KEY` is set
- Check that you have API credits/quota

---

## Additional Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [Stripe Testing](https://stripe.com/docs/testing)
- [MongoDB Manual](https://www.mongodb.com/docs/manual/)
- [NextAuth.js](https://next-auth.js.org/)
- [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)
