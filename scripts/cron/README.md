# Cron jobs

One job = one HTTP route under `src/app/api/cron/<job>` + one schedule in `vercel.json` + one
runner here named `cron.<job>.ts`. `tests/lib/cronMap.test.ts` fails if any of the three is added
without the others, and also if the table below drifts from `vercel.json`. Nothing runs it
automatically — there is no CI workflow in this repo — so run `npm run tests:lib:vitest` yourself.

| Job | Vercel schedule | Route | Manual run |
|---|---|---|---|
| `doc-metrics` | `0 */6 * * *` (every 6 hours at :00) | `/api/cron/doc-metrics` | `npm run cron:doc-metrics` |
| `stripe-credits-reconcile` | `15 */6 * * *` (every 6 hours at :15) | `/api/cron/stripe-credits-reconcile` | `npm run cron:stripe-credits-reconcile` |
| `stripe-credits-report` | `30 * * * *` (hourly at :30) | `/api/cron/stripe-credits-report` | `npm run cron:stripe-credits-report` |
| `credits-cycle-reconcile` | `10 * * * *` (hourly at :10) | `/api/cron/credits-cycle-reconcile` | `npm run cron:credits-cycle-reconcile` |
| `usage-agg-reconcile` | `20 * * * *` (hourly at :20) | `/api/cron/usage-agg-reconcile` | `npm run cron:usage-agg-reconcile` |
| `notification-emails` | `*/5 * * * *` (every 5 minutes) | `/api/cron/notification-emails` | `npm run cron:notification-emails` |
| `plan-limits` | `40 * * * *` (hourly at :40) | `/api/cron/plan-limits` | `npm run cron:plan-limits` |
| `analytics-reconcile` | `50 3 * * *` (nightly at 03:50 UTC) | `/api/cron/analytics-reconcile` | `npm run cron:analytics-reconcile` |
| `credits-purchase-expiry` | `5 4 * * *` (nightly at 04:05 UTC) | `/api/cron/credits-purchase-expiry` | `npm run cron:credits-purchase-expiry` |
| `credits-stale-reservations` | `25 * * * *` (hourly at :25) | `/api/cron/credits-stale-reservations` | `npm run cron:credits-stale-reservations` |
| `account-purge` | `30 4 * * *` (nightly at 04:30 UTC) | `/api/cron/account-purge` | `npm run cron:account-purge` |

`analytics-reconcile` is the one job whose output you should read rather than just check for a 200.
It repairs `ShareLink`'s denormalized counters from the analytics rows, and separately *reports*
rows whose per-page time exceeds their total — the signature of an ingest double count, which it
deliberately never repairs, because overwriting the rows would hide the bug. A run that finds any
marks itself `error` in `CronHealth`. See DEPLOY.md section 9.1.

## How they run in production

Vercel Cron calls each route with `GET` and `Authorization: Bearer $CRON_SECRET` on the schedule
above (`vercel.json` is the source of truth; Vercel reads it at deploy). Routes take a Mongo
lease (`src/lib/cron/lease.ts`) so an overlapping run is skipped, record a `CronHealth` row, and
accept `POST` too. Auth: `src/lib/cron/auth.ts` (`CRON_SECRET`, legacy `LNKDRP_CRON_SECRET`;
fails closed in production when neither is set).

## Running one by hand

```
npm run cron:plan-limits -- --dry-run                 # against the local dev server (:3001)
npm run cron:plan-limits -- --target=https://lnkdrp.com   # production; needs CRON_SECRET in the env
npm run cron:doc-metrics -- --limit=200 --post
```

The runner (`lib.ts`) only calls the route; it never re-implements a job. `--dry-run` and
`--limit` are passed through as query parameters for routes that support them.

## If the app ever leaves Vercel Cron

The same scripts work from any scheduler. A system crontab on the services host:

```
CRON_SECRET=…  CRON_TARGET_URL=https://lnkdrp.com
0 */6 * * *  cd /srv/lnkdrp && npm run -s cron:doc-metrics
15 */6 * * * cd /srv/lnkdrp && npm run -s cron:stripe-credits-reconcile
30 * * * *   cd /srv/lnkdrp && npm run -s cron:stripe-credits-report
10 * * * *   cd /srv/lnkdrp && npm run -s cron:credits-cycle-reconcile
20 * * * *   cd /srv/lnkdrp && npm run -s cron:usage-agg-reconcile
*/5 * * * *  cd /srv/lnkdrp && npm run -s cron:notification-emails
40 * * * *   cd /srv/lnkdrp && npm run -s cron:plan-limits
25 * * * *   cd /srv/lnkdrp && npm run -s cron:credits-stale-reservations
50 3 * * *   cd /srv/lnkdrp && npm run -s cron:analytics-reconcile
5 4 * * *    cd /srv/lnkdrp && npm run -s cron:credits-purchase-expiry
30 4 * * *   cd /srv/lnkdrp && npm run -s cron:account-purge
```

All eleven, deliberately: this block once listed seven, and the four it left out were the
ones nobody notices missing — deleted accounts never purged, credit purchases never expired.

Keep the two schedules identical; the leases make an accidental double-scheduler harmless.

## Adding a job

1. `src/app/api/cron/<job>/route.ts` with `runtime = "nodejs"`, `maxDuration`, `requireCronAuth`, a lease.
2. Add `{ "path": "/api/cron/<job>", "schedule": "…" }` to `vercel.json`.
3. `scripts/cron/cron.<job>.ts` (copy any sibling) and `"cron:<job>"` in `package.json`.
4. Document it in `docs/CRON.md`, in the table above and in the crontab block. Run
   `npm run tests:lib:vitest` — the table and `vercel.json` are pinned to each other.
