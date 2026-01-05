# Cron jobs

This project uses cron jobs to run **server-side rollups** that cache expensive-to-compute values into MongoDB so the UI can render quickly without extra queries.

## Schedule source of truth

Production cron schedules are defined in `vercel.json`.
The cron routes in `src/app/api/cron/*` are invoked by Vercel on those schedules.
If you add/rename a cron route, you must update `vercel.json` and `docs/CRON.md` together.

### Running manually

All cron routes can be triggered manually in dev/staging via `POST` requests (auth-gated if applicable), e.g. `POST /api/cron/<job>`.

## Cron inventory (current)

This document lives at **`./docs/CRON.md`**.

All cron endpoints are **`POST`** routes under `/api/cron/*` and write a `CronHealth` heartbeat (best-effort) keyed by `jobKey`.
When enabled via env, failures are also recorded as an `ErrorEvent` (sanitized, TTL-retained) for queryable debugging.

Frequencies below are from `vercel.json` `"crons"` (production source of truth).

- **Doc metrics rollup**
  - **Route**: `POST /api/cron/doc-metrics`
  - **Schedule**: `0 */6 * * *` (every 6 hours)
  - **Purpose**: roll up per-doc metrics into a cached snapshot for fast UI rendering.
  - **Writes**: `Doc.metricsSnapshot` (rollup) + `CronHealth(jobKey="doc-metrics")`
  - **Idempotency**: safe to rerun; rollup overwrites the cached snapshot deterministically.
- **Credits cycle reconcile (hourly backstop)**
  - **Route**: `POST /api/cron/credits-cycle-reconcile`
  - **Schedule**: `10 * * * *` (hourly)
  - **Purpose**: hourly safety net to ensure each active paid workspace has received its included credit grant for the current Stripe billing cycle.
  - **Reads**: `Subscription` (active/trialing, `stripeSubscriptionId`, stored period boundaries), `CreditLedger` (`cycle_grant_included`), Stripe subscription (best-effort when stale/missing)
  - **Writes**: `CreditLedger(eventType="cycle_grant_included")` + `WorkspaceCreditBalance` via `grantCycleIncludedCredits`; `CronHealth(jobKey="credits-cycle-reconcile")`
  - **Idempotency**: uses `cycleKey = ${stripeSubscriptionId}:${current_period_start_unix_seconds}`; grant helper is safe under retries and concurrent webhook/cron execution.
- **Stripe credits reconcile (cycle backstop)**
  - **Route**: `POST /api/cron/stripe-credits-reconcile`
  - **Schedule**: `15 */6 * * *` (every 6 hours)
  - **Purpose**: heavier backstop that fetches Stripe subscription objects, syncs stored billing-cycle boundaries, and ensures the included credit grant exists.
  - **Writes**: `Subscription.currentPeriodStart/currentPeriodEnd` (best-effort sync) + `CreditLedger`/`WorkspaceCreditBalance` via `grantCycleIncludedCredits`; `CronHealth(jobKey="stripe-credits-reconcile")`
  - **Idempotency**: cycle grant is keyed by `cycleKey` and is safe under retries.
- **Stripe credits report (metered usage)**
  - **Route**: `POST /api/cron/stripe-credits-report`
  - **Schedule**: `30 * * * *` (hourly)
  - **Purpose**: report metered **on-demand/overage credits only** to Stripe for Pro workspaces.
  - **Reads**: `CreditLedger(status="charged", creditsFromOnDemand>0, stripeUsageReportedAt=null)` + `Subscription.stripeSubscriptionItemId`
  - **Writes**: marks `CreditLedger.stripeUsageReportedAt` after reporting; `CronHealth(jobKey="stripe-credits-report")`
  - **Idempotency**: Stripe idempotency keys per batch + ledger `stripeUsageReportedAt` marking prevents duplicates across retries.
- **Usage aggregates reconcile (hourly)**
  - **Route**: `POST /api/cron/usage-agg-reconcile`
  - **Schedule**: `20 * * * *` (hourly)
  - **Purpose**: recompute pre-aggregated usage totals for fast dashboard/credits reporting.
  - **Reads**: `CreditLedger(status="charged", eventType="ai_run")`
  - **Writes**: `UsageAggDaily`, `UsageAggCycle`, `CronHealth(jobKey="usage-agg-reconcile")`
  - **Idempotency**: deterministic recompute via upserts; safe to re-run for the same date range.

## Doc metrics rollup (cached snapshot)

### What it does
- Computes a **cached metrics snapshot** per doc and stores it on the `Doc` record at `doc.metricsSnapshot`.
- The **doc detail page** (`/doc/:docId`) uses this snapshot to show a quick “Last 15d views / downloads” glimpse **without querying** the metrics endpoint.

### Data sources
- **Views**: counted from `ShareView.createdDate` within the last N days.
- **Downloads**: counted from `ShareView.downloadsByDay` (written when `/s/:shareId/pdf?download=1` is requested).

### Code locations
- **Rollup logic**: `src/lib/metrics/rollupDocMetrics.ts` (`rollupDocMetrics`)
- **Cron endpoint**: `src/app/api/cron/doc-metrics/route.ts` (`POST /api/cron/doc-metrics`)
- **Local runner script**: `scripts/rollup-doc-metrics.ts`
- **Doc API includes snapshot**: `src/app/api/docs/[docId]/route.ts` (returns `doc.metricsSnapshot`)
- **Doc page uses snapshot (no extra query)**: `src/app/(app)/doc/[docId]/pageClient.tsx`
- **Cron health heartbeat (DB snapshot)**: `src/lib/models/CronHealth.ts` (`CronHealthModel`, `jobKey: "doc-metrics"`)
- **Admin health API**: `src/app/api/admin/cron-health/route.ts` (`GET /api/admin/cron-health`)
- **Admin UI page**: `src/app/a/cron-health/page.tsx` (shows latest cron health)

## Cron health (heartbeat snapshots)

Cron endpoints can upsert a small “health” record in MongoDB so we can see whether background jobs are running and when they last succeeded/failed.

### What it stores
- `jobKey`: stable ID for the job (example: `"doc-metrics"`).
- `status`: `"running" | "ok" | "error"`.
- `lastRunAt`, `lastStartedAt`, `lastFinishedAt`, `lastDurationMs`.
- `lastErrorAt`, `lastError` (only when the last run errored).

### How it’s written
- Cron endpoints should write `"running"` at the start and `"ok"`/`"error"` at the end (best-effort).

## Vercel configuration

### Recommended production schedules

- `/api/cron/doc-metrics` — **every 6 hours**
- `/api/cron/credits-cycle-reconcile` — **hourly** (backstop for missed/delayed webhooks; ensures included credits grant exists)
- `/api/cron/stripe-credits-reconcile` — **every 6 hours** (heavier Stripe sync + grant backstop)
- `/api/cron/stripe-credits-report` — **hourly** (reports metered credits usage to Stripe)
- `/api/cron/usage-agg-reconcile` — **hourly** (recomputes usage aggregates from ledger)

If you deploy on Vercel, these are configured in `vercel.json` under `"crons"` so schedules are committed in-repo (recommended).
You can also manage schedules from Vercel UI (Project → Settings → Cron Jobs), but `vercel.json` is the source of truth for production in this repo.

### Secure the endpoints (recommended)
Set an environment variable in Vercel:
- `LNKDRP_CRON_SECRET`: a random secret string

Then configure the cron job to send **one** of the following:
- Header `x-cron-secret: <LNKDRP_CRON_SECRET>`
- OR header `authorization: Bearer <LNKDRP_CRON_SECRET>`
- OR include `?secret=<LNKDRP_CRON_SECRET>` in the cron URL

If `LNKDRP_CRON_SECRET` is not set, the endpoint will run **without auth**.

### Optional query params
- `days`: day window (default `15`, max `60`)
- `limit`: number of docs processed per run (default `50`, max `500`)
- `docId`: process a single doc

Examples:
- `/api/cron/doc-metrics?days=15&limit=100`
- `/api/cron/doc-metrics?docId=<DOC_ID>&days=15`

## Local development

### Required env
Ensure Mongo is configured locally (same as running the app):
- `MONGODB_URI` must be available in `.env.local` (preferred) or `.env`

### Run once

```bash
npm run metrics:rollup:once
```

Run for one doc:

```bash
npm run metrics:rollup:once -- --docId <DOC_ID>
```

### Run continuously (every 10 seconds)

```bash
npm run metrics:rollup:dev -- --limit 50
```

Note: the local rollup runner also writes a `CronHealth` heartbeat (`jobKey: "doc-metrics"`) so `/a/cron-health` reflects local background runs.
When enabled via env, the runner also records failures as an `ErrorEvent` (category `worker`).

Override interval:

```bash
npm run metrics:rollup:dev -- --interval 5000
```

### Calling the cron endpoint locally
If you already have the dev server running on port `3001`, you can call:

```bash
curl -X POST "http://localhost:3001/api/cron/doc-metrics?limit=50&days=15"
```

If `LNKDRP_CRON_SECRET` is set locally, include it:

```bash
curl -X POST \
  -H "x-cron-secret: $LNKDRP_CRON_SECRET" \
  "http://localhost:3001/api/cron/doc-metrics?limit=50&days=15"
```

## Stripe credits reconcile (cycle backstop)

### What it does
- Backstops missed/delayed Stripe webhooks by syncing the latest Stripe subscription period boundaries.
- Ensures the included credits reset/grant is applied **once per billing cycle** (idempotent by `cycleKey`).

### Code locations
- **Cron endpoint**: `src/app/api/cron/stripe-credits-reconcile/route.ts` (`POST /api/cron/stripe-credits-reconcile`)
- **Credit cycle grant helper**: `src/lib/credits/grants.ts` (`grantCycleIncludedCredits`, `cycleKey`)
- **Cron health**: `CronHealth.jobKey = "stripe-credits-reconcile"`

## Stripe credits report (metered usage backstop)

### What it does
- Reports aggregated **credits** usage to Stripe for Pro workspaces (metered subscription item).
- Marks ledger rows as reported to prevent double-reporting; also uses Stripe idempotency keys per batch.
- Reports **on-demand overage credits only** (not included credits).

### Code locations
- **Cron endpoint**: `src/app/api/cron/stripe-credits-report/route.ts` (`POST /api/cron/stripe-credits-report`)
- **Cron health**: `CronHealth.jobKey = "stripe-credits-report"`

## Credits (cycle grants + metered reporting)

### Core concepts
- **Billing cycle source of truth**: Stripe subscription period boundaries (`current_period_start/current_period_end`).
- **Cycle key**:
  - `cycleKey = ${stripeSubscriptionId}:${currentPeriodStartUnixSeconds}`
- **Idempotency rule**:
  - Included credits grant is recorded as a `CreditLedger` entry with `eventType="cycle_grant_included"` and `cycleKey`.
  - Duplicate grants are safe (unique constraints + duplicate-key handling treat it as already granted).

### Relationship to webhooks
- **Webhooks are fast**: Stripe webhooks update `Subscription.currentPeriodStart/currentPeriodEnd` and trigger the included credits grant immediately.
- **Cron makes it correct**: the hourly cycle reconcile cron backfills missed/delayed webhook delivery.

### Credits cycle reconcile (hourly backstop)

- **Route**: `POST /api/cron/credits-cycle-reconcile`
- **Purpose**: Ensure each active paid workspace has received its included credits grant for the current billing cycle (within ≤ 1 hour).
- **Reads**:
  - `SubscriptionModel` (active/trialing, `stripeSubscriptionId`, stored period boundaries)
  - `CreditLedgerModel` (existing `cycle_grant_included` rows)
  - Stripe subscription (best-effort; only when stored period data is missing or stale)
- **Writes**:
  - `CreditLedgerModel` (cycle grant ledger entry) + `WorkspaceCreditBalanceModel` (via `grantCycleIncludedCredits`)
  - `SubscriptionModel` period fields (best-effort when Stripe is fetched)
  - `CronHealthModel` heartbeat (`jobKey: "credits-cycle-reconcile"`)
- **Idempotency**: safe under retries and concurrent webhook/cron execution (grant helper is idempotent).

### Stripe credits report (metered on-demand only)
- Reports **on-demand/overage credits only** (not included plan credits).
- **Route**: `POST /api/cron/stripe-credits-report`


