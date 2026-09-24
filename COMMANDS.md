# Commands

Every command you might type against this repo, in one searchable place. Each `npm run` line is
a script in `package.json`; the `:prod` variants read `.env.production.local` instead of
`.env.local` and touch **production data**. `--` separates npm's arguments from the script's.

When a section says "see", that document has the why and the caveats; this file only has the what.

## Run the app locally

| What | Command |
|---|---|
| Install dependencies | `npm install` |
| Next app on http://localhost:3001 | `npm run dev` |
| Same, with webpack polling (network drives, Synology) | `npm run dev:webpack` |
| Realtime WebSocket server on :8788 | `npm run realtime` |
| MCP server on :8787 (needs the app on :3001) | `npm run mcp` |
| MCP over stdio for one key (`LNKDRP_API_KEY` set) | `npm run mcp -- --stdio` |
| Production build + start on :3001 | `./prod.sh` (`--skip-build` to only start) |
| Lint | `npm run lint` |
| Typecheck | `npx tsc --noEmit -p .` |
| Regenerate `INDEX.md` (the code map) | `npm run index` |

All three servers read `.env.local`. The realtime server needs `MONGODB_URI` to name the database the
Atlas user actually has a role on; a mismatch now fails at boot with a message naming both sides.

## People: waitlist and admins

| What | Command |
|---|---|
| Let one person off the waitlist and email their invitation | `npm run waitlist:invite -- --to=someone@example.com` |
| Same, without sending (shows what would happen) | `npm run waitlist:invite -- --to=someone@example.com --dry` |
| Same, with a longer invite link life | `npm run waitlist:invite -- --to=someone@example.com --ttl-days=30` |
| Make an account an admin (also approves it off the queue) | `npm run admin:add -- --to=someone@example.com` |
| Take admin back | `npm run admin:add -- --to=someone@example.com --remove` |
| List admins | `npm run admin:list` |
| Production versions | `npm run waitlist:invite:prod -- --to=…`, `npm run admin:add:prod -- --to=…`, `npm run admin:list:prod` |

`waitlist:invite` sends real mail even with `EMAIL_TRANSPORT=console`; use `--dry` to look first.
The `:prod` scripts need a real `MONGODB_URI` and `NEXTAUTH_SECRET` in `.env.production.local`
(`vercel env pull` writes empty strings for Sensitive vars). See `PRODUCTION.md`, "Blockers".

## Check configuration

| What | Command |
|---|---|
| Preflight `.env.local` (connects to Mongo, Stripe, Google, Blob…) | `npm run preflight:env` |
| Preflight `.env.production.local` | `npm run preflight:env:prod` |
| Preflight any env file | `npx tsx --env-file=prod.env scripts/preflight-env.ts` |
| Generate fresh production secrets | `node scripts/gen-env-secrets.mjs` |
| Blob store smoke test | `npm run blob:test` |
| Print a session cookie for a local account (dev only) | `npx tsx --env-file=.env.local scripts/dev-session-token.ts` |

## Tests

| Suite | Command |
|---|---|
| The gate: lib, credits and upload suites in one go (what CI runs) | `npm test` |
| Library unit tests | `npm run tests:lib:vitest` |
| Credits | `npm run tests:credits:vitest` |
| Upload pipeline | `npm run tests:upload:vitest` |
| Agent API (vitest) | `npm run tests:agent:vitest` |
| Agent API (CLI harness) | `npm run tests:agent` |
| Route smoke tests | `npm run tests:routes` |
| Request timing benchmark | `npm run tests:benchmark` |
| One test file | `npx vitest run --config tests/lib/vitest.config.ts tests/lib/<name>.test.ts` |
| MCP end-to-end (see `docs/MCP.md`, "Running the e2e") | `npx tsx tests/mcp/e2e.ts` |
| Account deletion end-to-end (touches the configured DB and blob store) | `npm run test:account-deletion` |
| Render every email template to one inbox | `npm run test:emails` |
| Notification emails, local runner | `npm run test:notification-emails` |
| AI extraction against a text file | `npm run test:ai-extract` |
| PDF first page to PNG / PDF to text | `npm run test:pdf2png`, `npm run test:pdf2txt` |
| Image token cost measurement | `npm run measure:image-tokens` |

The release gate (`DEPLOY.md` 9) is: tsc, eslint, `npm test`, `npx next build`. The first three also run in GitHub Actions on every pull request (`.github/workflows/test.yml`).

## Cron jobs, run by hand

Production runs these from `vercel.json` (`docs/CRON.md` is the pinned list). Locally, each has a
runner that reads `.env.local`:

| Job | Command |
|---|---|
| Notification emails | `npm run cron:notification-emails` |
| Visit briefs | `npm run cron:visit-briefs` |
| Doc metrics rollup | `npm run cron:doc-metrics` |
| Plan limits | `npm run cron:plan-limits` |
| Credits cycle reconcile | `npm run cron:credits-cycle-reconcile` |
| Credits purchase expiry | `npm run cron:credits-purchase-expiry` |
| Credits stale reservations | `npm run cron:credits-stale-reservations` |
| Stripe credits reconcile / report | `npm run cron:stripe-credits-reconcile`, `npm run cron:stripe-credits-report` |
| Usage aggregates reconcile | `npm run cron:usage-agg-reconcile` |
| Analytics reconcile | `npm run cron:analytics-reconcile` |
| Account purge | `npm run cron:account-purge` |
| Metrics rollup loop (dev) / once | `npm run metrics:rollup:dev`, `npm run metrics:rollup:once` |

## Data jobs and audits

Read-only:

| What | Command |
|---|---|
| Share analytics invariants | `npm run verify:analytics` |
| Stored blob URLs point at our store | `npm run audit:blob-urls` |
| Orphan data report | `npx tsx --env-file=.env.local scripts/orphan-data-report.ts` |
| Debug a doc's upload versions and change history | `npx tsx --env-file=.env.local scripts/debug-doc-history.ts` |

Writes (backfills and repairs; read the header comment in each script first):

| What | Command |
|---|---|
| One `sharelinks` row per document | `npm run sharelinks:backfill` |
| Analytics rows get their link and workspace | `npm run sharelinks:analytics-backfill` |
| Delete AI runs and request repos, nothing else | `npm run mongo:clear:ai-runs-requests` |
| Orphan data cleanup (safe by default) | `npx tsx --env-file=.env.local scripts/orphan-data-cleanup.ts` |
| Recount doc view counters | `npx tsx --env-file=.env.local scripts/doc-view-counters-recount.ts` |
| Other one-offs | `scripts/*-backfill.*`, `scripts/*-repair.ts`, `scripts/*-recount.*`, `scripts/*-reconcile.ts` |
| **Empty the local database** (refuses anything not on this machine) | `npm run reset` |

## Stripe locally

See `README.md`, "Stripe subscriptions and credit packs".

```
stripe login
stripe listen --forward-to localhost:3001/api/stripe/webhook
```

Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` in `.env.local` and restart `npm run dev`.

## Production

The runbook is `DEPLOY.md`; the ledger of what is done is `PRODUCTION.md`. The commands you reach
for most:

| What | Command |
|---|---|
| Deployed version | `curl -s https://www.lnkdrp.com/api/health` |
| What is aliased on Vercel | `vercel ls --prod --scope christian-sanzs-projects`, `vercel inspect <url>` |
| Pull production env names into `.env.production.local` | `vercel env pull .env.production.local --environment=production` |
| Realtime on Fly (full block in `DEPLOY.md` 6.2) | `fly deploy --ha=false --config deploy/fly/realtime.fly.toml --dockerfile realtime/Dockerfile` |
| MCP on Fly (full block in `DEPLOY.md` 7) | `fly deploy --ha=false --config deploy/fly/mcp.fly.toml --dockerfile mcp/Dockerfile` |
| Service health on Fly | `curl https://lnkdrp-realtime.fly.dev/healthz`, `curl https://lnkdrp-mcp.fly.dev/healthz` |
| Dev copies on Fly (`dev-lnkdrp-realtime`, `dev-lnkdrp-mcp`, org `lnkdrp`) | `fly deploy -a dev-lnkdrp-realtime --config deploy/fly/dev-realtime.fly.toml --dockerfile realtime/Dockerfile --ha=false`; MCP: `fly deploy -a dev-lnkdrp-mcp --config deploy/fly/dev-mcp.fly.toml --dockerfile mcp/Dockerfile --ha=false -e LNKDRP_API_URL=https://www.lnkdrp.com -e MCP_PUBLIC_URL=https://dev-lnkdrp-mcp.fly.dev -e NEXT_PUBLIC_REALTIME_URL=` |
| Realtime end to end (ticket, socket, a change-stream frame) | `TEST_REALTIME_URL=wss://dev-lnkdrp-realtime.fly.dev npx tsx --env-file=.env.local scripts/realtime-e2e.ts` |
| Fly logs | `fly logs -a lnkdrp-realtime`, `fly logs -a lnkdrp-mcp` |
| Build the service images anywhere | `docker build -f realtime/Dockerfile -t lnkdrp-realtime .`, `docker build -f mcp/Dockerfile -t lnkdrp-mcp .` |
| Both services with Compose | `docker compose -f deploy/docker-compose.yml --env-file .env.production.services up -d --build` |

Run every `fly` and `docker build` from the repository root: both Dockerfiles copy files out of
`src/lib`.
