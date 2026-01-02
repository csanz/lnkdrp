# Cron jobs

This project uses cron jobs to run **server-side rollups** that cache expensive-to-compute values into MongoDB so the UI can render quickly without extra queries.

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

### 1) Create a Cron Job
In Vercel:
- Project → **Settings** → **Cron Jobs**
- Add a job that calls:
  - Path: `/api/cron/doc-metrics`
  - Method: `POST`
  - Schedule: up to you (e.g. every minute / every 5 minutes)

### 2) Secure the endpoint (recommended)
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


