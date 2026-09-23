# Cron jobs

This project uses cron jobs to run **server-side rollups** that cache expensive-to-compute values into MongoDB so the UI can render quickly without extra queries.

## Schedule source of truth

Production cron schedules are defined in `vercel.json`.
The cron routes in `src/app/api/cron/*` are invoked by Vercel on those schedules.
If you add/rename a cron route, you must update `vercel.json` and `docs/CRON.md` together.

### Running manually

All cron routes accept both **`GET`** and **`POST`** (same handler). Vercel Cron invokes them with `GET`; `POST` is kept for manual/dev invocation, e.g. `curl -X POST /api/cron/<job>`. Both are auth-gated (see "Secure the endpoints" below).

## Cron inventory (current)

This document lives at **`./docs/CRON.md`**.

All cron endpoints are **`GET`/`POST`** routes under `/api/cron/*` (`runtime = "nodejs"`, `maxDuration = 300`) and write a `CronHealth` heartbeat (best-effort) keyed by `jobKey`.
Auth is enforced by the shared helper `src/lib/cron/auth.ts` (`requireCronAuth`).
When enabled via env, failures are also recorded as an `ErrorEvent` (sanitized, TTL-retained) for queryable debugging.

Frequencies below are from `vercel.json` `"crons"` (production source of truth).

- **Doc metrics rollup**
  - **Route**: `GET|POST /api/cron/doc-metrics`
  - **Schedule**: `0 */6 * * *` (every 6 hours)
  - **Purpose**: roll up per-doc metrics into a cached snapshot for fast UI rendering.
  - **Writes**: `Doc.metricsSnapshot` (rollup) + `CronHealth(jobKey="doc-metrics")`
  - **Idempotency**: safe to rerun; rollup overwrites the cached snapshot deterministically.
- **Credits cycle reconcile (hourly backstop)**
  - **Route**: `GET|POST /api/cron/credits-cycle-reconcile`
  - **Schedule**: `10 * * * *` (hourly)
  - **Purpose**: hourly safety net to ensure each active paid workspace has received its included credit grant for the current Stripe billing cycle.
  - **Reads**: `Subscription` (active/trialing, `stripeSubscriptionId`, stored period boundaries), `CreditLedger` (`cycle_grant_included`), Stripe subscription (best-effort when stale/missing)
  - **Writes**: `CreditLedger(eventType="cycle_grant_included")` + `WorkspaceCreditBalance` via `grantCycleIncludedCredits`; `CronHealth(jobKey="credits-cycle-reconcile")`
  - **Idempotency**: uses `cycleKey = ${stripeSubscriptionId}:${current_period_start_unix_seconds}`; grant helper is safe under retries and concurrent webhook/cron execution.
- **Stripe credits reconcile (cycle backstop)**
  - **Route**: `GET|POST /api/cron/stripe-credits-reconcile`
  - **Schedule**: `15 */6 * * *` (every 6 hours)
  - **Purpose**: heavier backstop that fetches Stripe subscription objects, syncs stored billing-cycle boundaries, and ensures the included credit grant exists.
  - **Writes**: `Subscription.currentPeriodStart/currentPeriodEnd` (best-effort sync) + `CreditLedger`/`WorkspaceCreditBalance` via `grantCycleIncludedCredits`; `CronHealth(jobKey="stripe-credits-reconcile")`
  - **Bounds**: `?limit=` (default `200`, max `1000`); subscriptions are processed **stalest stored `currentPeriodEnd` first** (nulls first) so every row is eventually visited. Per-subscription errors are isolated and counted in `errors`.
  - **Overlap**: holds a `CronHealth` lease (see "Overlap lease" below); returns `200 { skipped: "locked" }` if a run is already in progress.
  - **Idempotency**: cycle grant is keyed by `cycleKey` and is safe under retries.
- **Stripe credits report (metered usage)**
  - **Route**: `GET|POST /api/cron/stripe-credits-report`
  - **Schedule**: `30 * * * *` (hourly)
  - **Purpose**: report metered **on-demand/overage credits only** to Stripe for Pro workspaces.
  - **Reads**: `CreditLedger(status="charged", creditsFromOnDemand>0, stripeUsageReportedAt=null)` + `Subscription.stripeSubscriptionItemId`
  - **Writes**: claims rows (`reportBatchId`, `reportClaimedAt`), then marks `CreditLedger.stripeUsageReportedAt` after reporting; `CronHealth(jobKey="stripe-credits-report")`
  - **Bounds**: `?limit=` (default `200`, max `500`) rows per step.
  - **Overlap**: holds a `CronHealth` lease (see "Overlap lease" below); returns `200 { skipped: "locked" }` if a run is already in progress.
  - **Idempotency**: claim-then-report. Rows are claimed under a deterministic `reportBatchId`, which is also the Stripe meter event `identifier` (+ request idempotency key). A run that crashed after claiming leaves stale claims (>30 min); the next run **replays** them under their stored `reportBatchId` (Stripe de-duplicates) and only then claims fresh, never-claimed rows, so a partial failure can never re-batch already-reported credits under a new identifier.
- **Usage aggregates reconcile (hourly)**
  - **Route**: `GET|POST /api/cron/usage-agg-reconcile`
  - **Schedule**: `20 * * * *` (hourly)
  - **Purpose**: recompute pre-aggregated usage totals for fast dashboard/credits reporting.
  - **Reads**: `CreditLedger(status="charged", eventType="ai_run")`
  - **Writes**: `UsageAggDaily`, `UsageAggCycle`, `CronHealth(jobKey="usage-agg-reconcile")`
  - **Idempotency**: deterministic recompute via upserts; safe to re-run for the same date range.
- **Notification emails (views + doc updates + new documents + visit briefs + request repos)**
  - **Route**: `GET|POST /api/cron/notification-emails`
  - **Schedule**: `*/5 * * * *` (every 5 minutes)
  - **Purpose**: drain the **notification queue** (`notificationqueue`, see docs/prds/lnkdrp-notification-queue.md). One row is one email owed to one member, written when the thing happened (a `ShareView` created, a replacement upload completed, a request upload received). The tick delivers what is written down, retries what fails, and stops retrying what cannot succeed. Nothing here scans source collections behind a cursor any more, and `NotificationEmailCursor` is neither read nor written.
    - **A tick**: recover stale claims (`sending` for more than 10 minutes belongs to a run that died) → group due `pending` rows by (workspace, member, kind), oldest backlog first, capped by `limitMembers` (5,000 groups) → resolve that member's current preference → claim atomically (`pending → sending`) → render → send → mark `sent` / `failed` / `skipped`.
    - **Preference at send, not at enqueue** (`OrgMembership.viewEmailMode` / `docUpdateEmailMode` / `repoLinkRequestEmailMode`, **default `daily`**): a member who turns emails on today hears about yesterday, and a member who turned them off has their pending rows marked `skipped` with a reason rather than deleted.
    - **Immediate**: sent on the next tick, at most `limitEventsPerMember` (20) rows per member per kind; the rest roll into the following tick. View emails are still one email per document; doc updates and request uploads are one email per batch.
    - **Daily**: rows stay `pending`, untouched, until the end-of-day UTC tick (23:00 onwards, or `?forceDigest=1`), which groups every pending row for that member and kind into one email and marks them all sent together. No `lastDigestDay` bookkeeping: a row is either sent or it is not.
    - **Retries**: `attempts += 1` with backoff `1m, 5m, 30m, 2h, 12h`; after 5 attempts the row is `dead`, keeps its `lastError`, and is never retried automatically. A failed message holds only its own rows — it no longer rewinds anything for anyone else.
    - **Skips** (never retried, reason recorded): the member is off, the membership is gone, the user has no address, the source row or the document is gone.
    - **Held, not claimed** (stays `pending` for a later tick): a `daily` member before the end-of-day tick, `repo_link_requests` while `NEXT_PUBLIC_FEATURE_REQUESTS` is off, and view emails when no absolute site URL is configured in production (every link would be dead in a mail client; counted in `views.errors`).
    - **Identity**: unchanged and Pro-only. Pro immediate emails name each viewer with pages and time; Pro digests give per-link counts and name the top viewer per link; Free gets which link was opened and when, with a Pro line. Every view email carries a signed one-click **Turn off these emails** link (`/api/notifications/views/off`, 30-day token) signed with the membership.
  - **Reads**: `NotificationQueue` (the due-groups aggregate and the claim), `OrgMembership` + `User` (preference and address for the members with something due only), `ShareView` + `ShareLink` (how far a reader got), `DocChange` (the replaced version and its diff summary), `Upload`, `Doc`, `Project`, and the workspace plan (view email identity)
  - **Writes**: `NotificationQueue` (claims and outcomes; `sent` rows expire after 30 days by TTL), `CronHealth(jobKey="notification-emails")`
  - **Volume**: view emails are on by default for every member, so this job emails every member of every workspace whose links were opened (a daily digest at minimum). See DEPLOY.md 4.6 for Resend plan sizing.
  - **Failure handling**: each message is isolated. A send that throws is counted (`sendFailures`, per-bucket `failed`) and its rows go back to `pending` with a later `nextAttemptAt`, or to `dead` on the last attempt — visible on `/a/emails` rather than lost. A render or load that throws for one member is logged, counted, and leaves that member's rows to the next tick (claimed ones return via the stale sweep); the rest of the run carries on.
  - **Dry run**: `?dryRun=1` (and the CLI, which is dry unless `--send`) is completely side-effect free: it does not claim, mark, or send. It reports what the next real tick would take.
  - **Overlap**: holds a `CronHealth` lease (see "Overlap lease" below); returns `200 { skipped: "locked" }` if a run is already in progress.
  - **Idempotency**: safe under retries. The queue's unique `dedupeKey` (`<kind>:<userId>:<source row id>`) means an event can only ever be owed once, and the claim filter (`status: "pending"`) means two runners cannot take the same row.
- **Visit briefs (close quiet visits, write the brief, send the visit emails)**
  - **Route**: `GET|POST /api/cron/visit-briefs`
  - **Schedule**: `*/5 * * * *` (every 5 minutes)
  - **Purpose**: the `VisitBrief` row is a debounce (docs/prds/lnkdrp-visit-briefs.md): every `POST /api/share/:shareId/stats` upserts one row per sitting (`{shareId, visitIdHash}`, unique) with `dueAt = lastEventAt + 2 min`. This tick claims rows whose `dueAt` has passed, re-reads the sitting's `ShareVisit` rows, and either pushes `dueAt` out again (the reader came back) or closes the visit: freezes the stats, applies the gates in order (owner preview and glances under 20 s on one page are `skipped`; Free workspaces are `skipped`; automatic briefs off, 100 briefs already today, or no credits give a `recap`), reserves one credit (`actionType: "brief"`), calls the model, charges with usage on the ledger row, stores the brief, records `share.visit_briefed`, enqueues one `visit_briefs` queue row per member, and drains that kind of the queue so the mail leaves in this tick. Model failures refund, retry after 1 m and 5 m, and give up on the third with the recap still sent.
  - **Reads**: `VisitBrief`, `ShareVisit`, `ShareView` (downloads), `ShareLink`, `Doc` (titles, the stored `pageOutline`, or the PDF once to build it), `Project`, `OrgMembership`, `WorkspaceCreditBalance` (`autoBriefEnabled`), the workspace plan
  - **Writes**: `VisitBrief`, `Doc.pageOutline` (once per upload version), `CreditLedger`, `AiRun`, `ActivityEvent` (`share.visit_briefed`, and `credits.exhausted` once per workspace per day), `NotificationQueue` (`visit_briefs`), the emails, `CronHealth(jobKey="visit-briefs")`
  - **Bounds**: `?limit=` rows claimed per tick (default 50, three model calls at a time); stops claiming after 240 s and hands the rest back. `?workspaceId=` scopes a run. `?dryRun=1` claims and writes nothing and reports what the next tick would take.
  - **Overlap**: `CronHealth` lease; a row `generating` for 10 minutes is handed back by the next tick. Claims carry a token, so a recovered row cannot be settled twice.
  - **Idempotency**: one row per sitting by unique index, one queue row per member by `dedupeKey`, one ledger row per attempt by idempotency key. Rerunning cannot write a second brief for the same visit.
  - **Latency**: quiet window plus cron interval — 2 to 7 minutes after a closed tab, 7 to 12 after a tab left open (the viewer's idle cut is 5 minutes).
- **Plan limits grace sweep (Free workspaces)**
  - **Route**: `GET|POST /api/cron/plan-limits`
  - **Schedule**: `40 * * * *` (hourly)
  - **Purpose**: advance the 14-day grace period (`LIMIT_GRACE_DAYS`) for Free workspaces that are over a Free limit (shared documents, projects, collaborators), email the workspace owners at each step, and clear grace when a workspace fixes it or upgrades. See "Plan limits grace sweep" below.
  - **Reads**: `Org` (`planGrace`), `Subscription` (active/trialing → Pro), `Doc` / `Project` / `OrgMembership` (usage via `getWorkspaceUsage`), `User` (owner emails)
  - **Writes**: `Org.planGrace`, `Org.planLimitsScannedAt` (rotation marker, stamped for every workspace the run scanned), `ActivityEvent` (`plan.grace_started` / `plan.grace_reminder` / `plan.grace_blocked` / `plan.upgraded`), `CronHealth(jobKey="plan-limits")`
  - **Bounds**: `?limit=` (default `500`, max `5000`) workspaces per run; workspaces already in grace are visited first, then the least recently scanned of the rest (`planLimitsScannedAt` ascending, null first), so the budget rotates through the whole collection instead of re-reading the newest N. `?dryRun=1` computes and counts without writing or sending, and does not advance the rotation.
  - **Overlap**: holds a `CronHealth` lease (see "Overlap lease" below); returns `200 { skipped: "locked" }` if a run is already in progress.
  - **Idempotency**: every transition is guarded by the persisted `Org.planGrace` (start only when `null`, block only once via `blockedAt`, reminders deduped by day bucket in `remindersSent`), so re-runs and overlapping ticks cannot double-email.

## Plan limits grace sweep (Free workspaces)

### What it does
- Free workspaces (no `active`/`trialing` subscription) that exceed a Free limit get a grace window before new links/projects are blocked. Existing links keep working throughout; nothing is deleted.
- State lives on `Org.planGrace = { startedAt, endsAt, blockedAt, remindersSent[] } | null`. `checkLimit()` in `src/lib/billing/planLimits.ts` reads the same field: inside the window an over-limit workspace still gets `ok: true` with a `warning`; after `blockedAt` it gets a `402 plan_limit`.
- Per workspace, each run:
  - over a limit and `planGrace` is `null` → set `{ startedAt: now, endsAt: now + 14d, blockedAt: null, remindersSent: [now] }`, email owners ("started"), record `plan.grace_started`
  - in grace and `now >= endsAt` → set `blockedAt = now`, email owners ("blocked"), record `plan.grace_blocked`
  - in grace, not blocked → send the day-7 and day-12 reminders once each (only the latest due one after downtime), email owners ("reminder"), record `plan.grace_reminder`
  - back under every limit → clear `planGrace` (they fixed it)
  - now on Pro → clear `planGrace`, record `plan.upgraded` once
- Emails go to every non-temp **owner** (`OrgMembership.role = "owner"`) via `sendPlanLimitEmail` → `sendTextEmail` (Resend; `EMAIL_TRANSPORT=console` logs instead of sending). Sends and activity rows are best-effort per workspace and counted in `errors`.

### Idempotency
- **Reminders**: `remindersSent` holds the send timestamps; a reminder for day *N* is considered sent when any entry falls in day bucket ≥ *N* (`floor((sent - startedAt) / 1d)`), so a re-run in the same hour, day, or after a missed tick never repeats it.
- **Start / block**: only when `planGrace` is `null` / `blockedAt` is `null` respectively, and the state is written before the email is sent.
- **Result**: `{ scanned, started, reminded, blocked, errors, cleared, upgraded, dryRun }`.

### Code locations
- **Sweep logic**: `src/lib/billing/planGrace.ts` (`runPlanLimitsGraceSweep`)
- **Email copy**: `src/lib/email/sendPlanLimitEmail.ts` (`sendPlanLimitEmail`, `buildPlanLimitEmail`)
- **Cron endpoint**: `src/app/api/cron/plan-limits/route.ts` (`GET|POST /api/cron/plan-limits`)
- **Local runner**: `scripts/plan-limits-grace.ts`
- **Cron health**: `CronHealth.jobKey = "plan-limits"`

### Local runner

```bash
# Dry run (default): computes transitions, writes nothing, sends nothing
npx tsx scripts/plan-limits-grace.ts --dry-run

# Real run (writes Org.planGrace, records activity, sends emails)
npx tsx scripts/plan-limits-grace.ts --send

# Real run without real emails
EMAIL_TRANSPORT=console npx tsx scripts/plan-limits-grace.ts --send

# Options: --limit <n> (default 500), --now <ISO> (reference time, e.g. to hit a reminder/block day locally)
npx tsx scripts/plan-limits-grace.ts --send --now 2026-09-20T12:00:00Z
```

## Doc metrics rollup (cached snapshot)

### What it does
- Computes a **cached metrics snapshot** per doc and stores it on the `Doc` record at `doc.metricsSnapshot`.
- The **doc detail page** (`/doc/:docId`) uses this snapshot to show a quick “Last 15d views / downloads” glimpse **without querying** the metrics endpoint.

### Data sources
- **Views**: counted from `ShareView.createdDate` within the last N days.
- **Downloads**: counted from `ShareView.downloadsByDay` (written when `/s/:shareId/pdf?download=1` is requested).

### Code locations
- **Rollup logic**: `src/lib/metrics/rollupDocMetrics.ts` (`rollupDocMetrics`)
- **Cron endpoint**: `src/app/api/cron/doc-metrics/route.ts` (`GET|POST /api/cron/doc-metrics`)
- **Rollup ordering**: docs are processed by `metricsSnapshot.updatedAt` ascending (never-rolled-up docs first), so `limit` bounds each run without starving any doc.
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

## Overlap lease

Jobs that must not run concurrently (`notification-emails`, `stripe-credits-reconcile`, `stripe-credits-report`, `plan-limits`) take a lease before doing work.

- **Implementation**: `src/lib/cron/lease.ts` (`acquireCronLease({ jobKey, ttlMs })` / `releaseCronLease(lease)`).
- **Storage**: `CronHealth.leaseUntil` (+ `leaseToken`) on the job's heartbeat row.
- **Semantics**: an atomic `findOneAndUpdate` succeeds only when `leaseUntil` is `null` or in the past. If it fails the route returns `200 { ok: true, skipped: "locked", jobKey }` and does nothing.
- **Expiry**: `ttlMs` (6 minutes, slightly above `maxDuration = 300s`) guarantees a crashed run releases the lease automatically. `releaseCronLease` clears it early on normal completion (in a `finally`), and only when the holder's token still matches.
- **Manual unblock**: if a job appears stuck as `locked` for longer than the TTL, clear `leaseUntil` on that `CronHealth` row.

## Vercel configuration

### Recommended production schedules

All eleven, matching `vercel.json`. `scripts/cron/README.md` carries the same table with the
manual-run command for each, and `tests/lib/cronMap.test.ts` pins that one to `vercel.json`.

- `/api/cron/doc-metrics` — **every 6 hours**
- `/api/cron/credits-cycle-reconcile` — **hourly** (backstop for missed/delayed webhooks; ensures included credits grant exists)
- `/api/cron/stripe-credits-reconcile` — **every 6 hours** (heavier Stripe sync + grant backstop)
- `/api/cron/stripe-credits-report` — **hourly** (reports metered credits usage to Stripe)
- `/api/cron/usage-agg-reconcile` — **hourly** (recomputes usage aggregates from ledger)
- `/api/cron/notification-emails` — **every 5 minutes** (view, doc update + request repo notification emails)
- `/api/cron/plan-limits` — **hourly** (Free plan-limit grace period: start / remind / block + owner emails)
- `/api/cron/credits-stale-reservations` — **hourly** (releases credit reservations whose run never finished, so the balance is not held hostage by a crashed job)
- `/api/cron/analytics-reconcile` — **nightly, 03:50 UTC** (repairs `ShareLink`'s denormalized counters from the analytics rows, and *reports* — never repairs — rows whose per-page time exceeds their total, the signature of an ingest double count. This is the one job whose output you read rather than just check for a 200)
- `/api/cron/credits-purchase-expiry` — **nightly, 04:05 UTC** (expires prepaid credit packs 12 months after purchase)
- `/api/cron/account-purge` — **nightly, 04:30 UTC** (hard-deletes accounts past their 30-day purge window after a self-service account deletion)

If you deploy on Vercel, these are configured in `vercel.json` under `"crons"` so schedules are committed in-repo (recommended).
You can also manage schedules from Vercel UI (Project → Settings → Cron Jobs), but `vercel.json` is the source of truth for production in this repo.

### Secure the endpoints (required in production)

Auth is handled by `src/lib/cron/auth.ts` (`requireCronAuth`). Set **one** of these env vars in Vercel (Production):
- `CRON_SECRET` (**preferred** — Vercel Cron automatically sends this one)
- `LNKDRP_CRON_SECRET` (legacy fallback; only used when `CRON_SECRET` is unset)

**Vercel Cron** invokes each route with `GET` and the header `Authorization: Bearer $CRON_SECRET`. No extra configuration is needed beyond setting `CRON_SECRET` on the project.

The helper accepts:
- Header `Authorization: Bearer <secret>` (use this everywhere)
- Header `x-cron-secret: <secret>` (legacy)
- Query `?secret=<secret>` — **dev only**. It is ignored when `NODE_ENV` or `VERCEL_ENV` is `production`, because a secret in a URL lands in request logs, log drains and monitor configs.

Comparison is constant-time (`crypto.timingSafeEqual`).

### Cron monitor (`GET /api/monitor/crons`)

Returns 200 while every job is healthy and 503 when any is `late`, `stuck`, `error` or `never-run`. Point an uptime monitor at it with the header form:

```bash
curl -H "Authorization: Bearer $CRON_MONITOR_SECRET" https://<host>/api/monitor/crons
```

Set `CRON_MONITOR_SECRET` for the monitor. It is read-only: it opens this route and cannot trigger any job, so the monitor vendor never holds a secret that runs billing or email crons. When it is unset, the route falls back to `CRON_SECRET`; `CRON_SECRET` is accepted either way. Use a monitor that can send a header; the `?secret=` form is refused in production.

A run left at `running` is `stuck` after one interval plus a minute, capped at 10 minutes. A row at `running` is also `late` when its last *finished* run (`lastFinishedAt`) is older than two intervals plus that stuck window, so a job killed mid-run every time (for example `notification-emails` every 5 minutes) goes red even though each new run resets `lastRunAt`.

**Fail closed**: if **no** secret is configured, requests are allowed only when `VERCEL_ENV !== "production"` **and** `NODE_ENV !== "production"`. In production with no secret every cron route returns `401`, so `CRON_SECRET` (or `LNKDRP_CRON_SECRET`) **must** be set in production.

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
If you already have the dev server running on port `3001`, you can call (GET or POST both work):

```bash
curl "http://localhost:3001/api/cron/doc-metrics?limit=50&days=15"
```

If `CRON_SECRET` (or `LNKDRP_CRON_SECRET`) is set locally, include it the way Vercel does:

```bash
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3001/api/cron/doc-metrics?limit=50&days=15"
```

## Stripe credits reconcile (cycle backstop)

### What it does
- Backstops missed/delayed Stripe webhooks by syncing the latest Stripe subscription period boundaries.
- Ensures the included credits reset/grant is applied **once per billing cycle** (idempotent by `cycleKey`).

### Code locations
- **Cron endpoint**: `src/app/api/cron/stripe-credits-reconcile/route.ts` (`GET|POST /api/cron/stripe-credits-reconcile`)
- **Overlap lease**: `src/lib/cron/lease.ts` (`CronHealth.leaseUntil`)
- **Credit cycle grant helper**: `src/lib/credits/grants.ts` (`grantCycleIncludedCredits`, `cycleKey`)
- **Cron health**: `CronHealth.jobKey = "stripe-credits-reconcile"`

## Stripe credits report (metered usage backstop)

### What it does
- Reports aggregated **credits** usage to Stripe for Pro workspaces (metered subscription item).
- Marks ledger rows as reported to prevent double-reporting; also uses Stripe idempotency keys per batch.
- Reports **on-demand overage credits only** (not included credits).

### Code locations
- **Cron endpoint**: `src/app/api/cron/stripe-credits-report/route.ts` (`GET|POST /api/cron/stripe-credits-report`)
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

- **Route**: `GET|POST /api/cron/credits-cycle-reconcile`
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
- **Route**: `GET|POST /api/cron/stripe-credits-report`


