# Production — state of things

A dated snapshot of what is actually live, what is not, and what stands between here and opening
the door. [`DEPLOY.md`](DEPLOY.md) is the runbook (how to do each step); this file is the ledger
(which steps are done). Update the date and the tables whenever production changes.

**As of 2026-09-23 23:25 UTC.** Every row below marked *verified* was checked against the live
system at that time; rows marked *reported* come from session notes and have not been re-checked.

## What is live

| | State | How it was checked |
|---|---|---|
| Web app | `https://www.lnkdrp.com` serving, `/api/health` → `{"ok":true,"mongo":"ok","env":"production"}`. The apex `lnkdrp.com` 308-redirects to `www`. | *verified*, curl |
| Deployed commit | `d8ac1ac` (head of `origin/main`), built 16:13 PDT, status Ready, aliased to `www.lnkdrp.com`, `lnkdrp.com`, `lnkdrp-one.vercel.app`. `/api/health` `version` reports the same SHA. | *verified*, `vercel inspect` + health |
| Vercel project | `christian-sanzs-projects/lnkdrp`, production branch `main`, region `iad1`. Pushes to `main` deploy automatically; the last two builds took about two minutes. Plan is Pro (inferred: the 12-job `vercel.json` would be rejected on Hobby). | *verified*, `vercel ls`/status API |
| Database | Atlas, database name `lnkdrp-prod`, reachable from the web app. Cluster tier, backup and point-in-time settings not checked from here. | *verified* name, rest unknown |
| Cron jobs | 12 registered from `vercel.json`: `notification-emails` and `visit-briefs` every 5 min; `credits-cycle-reconcile`, `usage-agg-reconcile`, `stripe-credits-report`, `plan-limits`, `credits-stale-reservations` hourly; `doc-metrics` and `stripe-credits-reconcile` every 6 h; `analytics-reconcile`, `credits-purchase-expiry`, `account-purge` daily. Note: `DEPLOY.md` still says "ten"; `docs/CRON.md` is the pinned list. Whether the scheduler has fired them is not checked (needs `/a/cron-health`, admin only). | *verified* config, not runs |
| Waitlist | **On.** `WAITLIST_ENABLED=1`; the homepage shows "Request access · we let people in a few at a time". New sign-ups wait on the queue page until an admin approves them. | *verified*, env + homepage |
| Admins | **None.** `npm run admin:list:prod` answers "No admins." With the queue on, nobody can approve anyone. | *verified*, 23:2x UTC |
| Auth | Google OAuth client id/secret and `NEXTAUTH_SECRET` set. Consent-screen publishing state not checked (if still "Testing", only listed test users can sign in). | *verified* env names only |
| Stripe | **Test mode.** The publishable key baked into the production bundle is `pk_test_…`. Nothing in production can take a real payment. `STRIPE_CREDITS_METER_EVENT_NAME` is set but empty. | *verified*, pricing page + env pull |
| Email | Resend API key set. `lnkdrp.com` MX is Google (`smtp.google.com`), so `hi@`/`support@` are Google-side; Resend domain verification (SPF/DKIM/DMARC) not checked from here. `NOTIFICATION_EMAIL_FROM` is set but empty, so the code's default From applies. | *verified* env, DNS |
| Blob | `BLOB_READ_WRITE_TOKEN` set; production previews and uploads are served from `*.public.blob.vercel-storage.com`. | *verified* |
| OpenAI | `OPENAI_API_KEY` set. Spend limits not checked. | *verified* env name |
| Support (Plain) | Chat app id (`NEXT_PUBLIC_PLAIN_CHAT_APP_ID`) set. **Neither `PLAIN_CHAT_SECRET` nor `PLAIN_REQUEST_SIGNING_SECRET` is set**, so signed-in users open the widget unsigned (Plain verifies them by emailed code) and the customer-cards endpoint answers 503 to Plain. | *verified* env names |
| Realtime (WebSockets) | **Not deployed.** `realtime.lnkdrp.com` has no DNS record; `NEXT_PUBLIC_REALTIME_URL` is set but empty, so the app is on polling only, which is the designed fallback. | *verified*, DNS + env pull |
| MCP server | **Not deployed.** `mcp.lnkdrp.com` has no DNS record. `/connect` and the homepage install snippets advertise `https://mcp.lnkdrp.com/mcp` (the default when `NEXT_PUBLIC_MCP_URL` is unset), so a user who follows them today gets a connection error. | *verified*, DNS + code |
| Feature flags | `NEXT_PUBLIC_FEATURE_REQUESTS` unset → request repositories hidden (intended for launch). `NEXT_PUBLIC_FEATURE_CREDITS` unset → credits on. | *verified* env names + defaults in code |
| Admin pages needing env | `VERCEL_API_TOKEN` unset → `/a/deployments` has nothing to show. `ERROR_LOGGING_*` unset → `/a/errors` uses defaults. `CRON_MONITOR_SECRET` unset → `/api/monitor/crons` cannot be used by an uptime monitor yet. | *verified* env names |

Production env var names present on Vercel (values not readable from the CLI for Sensitive vars):
`BLOB_READ_WRITE_TOKEN CRON_SECRET EMAIL_ADMIN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
LNKDRP_NOTIFICATION_TOKEN_SECRET LNKDRP_ORG_INVITE_TOKEN_SECRET LNKDRP_SHARE_PASSWORD_SECRET
MCP_PORT MONGODB_DB_NAME MONGODB_URI NEXT_PUBLIC_PLAIN_CHAT_APP_ID NEXT_PUBLIC_REALTIME_URL
NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
NEXTAUTH_SECRET NEXTAUTH_URL NOTIFICATION_EMAIL_FROM OPENAI_API_KEY REALTIME_PORT REALTIME_SECRET
RESEND_API_KEY STRIPE_AI_CREDITS_PRICE_ID STRIPE_CREDITS_METER_EVENT_NAME STRIPE_PRICE_ID
STRIPE_PUBLISH_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET WAITLIST_ENABLED`.
Not set and worth knowing: `WAITLIST_ALLOW_EMAILS` (put the owner's addresses in before announcing,
or the owner queues behind the launch), `PLAIN_CHAT_SECRET`, `PLAIN_REQUEST_SIGNING_SECRET`,
`VERCEL_API_TOKEN`, `CRON_MONITOR_SECRET`, `NEXT_PUBLIC_MCP_URL`.

## Where we are in the launch sequence

The steps are `DEPLOY.md` section 0. Status is against the live system, not the runbook's intent.

| Step | Status |
|---|---|
| Lead time: Stripe live activation | **Not started.** Production runs on test keys. |
| Lead time: Resend domain | Key present; verification state unknown. |
| Lead time: admin account with 2-Step Verification | **Not done.** No admins exist. |
| A. Local gate on the release commit | Done for `0637e1c` on 2026-09-23: tsc, eslint (0 errors), lib/credits/agent/upload suites, `next build`. `d8ac1ac` on top is a docs-only commit. |
| A. Merge through a pull request | Not how it happened: `fix/production-readiness` was fast-forwarded onto `main` directly. `main` protection is not verified. |
| B. Atlas M10+, backups, point-in-time | Unknown. |
| B. Stripe live catalog, webhook, portal | **Not done** (test mode). |
| B. Google OAuth consent screen "In production" | Unknown. |
| B. Blob, OpenAI, Resend keys | Present. |
| C. Realtime on Fly | **Not deployed.** App polls. |
| D. Web app on Vercel, domains, env, crons | **Done.** 12 crons registered; scheduler runs not yet proven. |
| E. MCP on Fly | **Not deployed**, while the product advertises the URL. |
| F. Verify: release checks 1–14 | Check 1 (health) passes. Checks 2–14 not run; several cannot run yet (7 realtime, 8 MCP, 10 Stripe live). |
| G. Budgets, alerts, uptime monitor, firewall, restore test | **Not done.** |
| G. Decide who gets in; make an admin first | Queue is on; **no admin**, so the first sign-up waits forever. |
| G. Announce | Not announced. Nothing links to the site yet. |

## Blockers before anyone is let in

In the order they bite:

1. **Make an admin.** `npm run admin:add:prod -- --to=<email>` (it also approves that account off
   the queue). `vercel env pull` writes empty strings for Sensitive vars, so `.env.production.local`
   must be given the real `MONGODB_URI` and `NEXTAUTH_SECRET` by hand first; a wrong
   `NEXTAUTH_SECRET` mints invite links production rejects. Then invite with
   `npm run waitlist:invite:prod -- --to=<email>`.
2. **Deploy the MCP server** (`DEPLOY.md` 7), or stop advertising `mcp.lnkdrp.com` until it exists.
   The product's whole pitch is the agent connection, and every install snippet points at a host
   that does not resolve.
3. **Stripe live mode** (`DEPLOY.md` 4.2). Until then every "Buy Pro" is a test charge. Fine for a
   closed beta if the testers know; not fine for anyone paying.
4. **Homepage product shots.** The four images under `public/images/home/` show three real venture
   partners by name as readers of a Series A deck (typed by hand into the Personal workspace, not
   seeded). Clean or reseed that workspace and retake all four before the page is linked anywhere.
   Metis task `mt_EdI_sXudDM`; needs the owner's signed-in browser.
5. **Plain secrets** in Vercel so support can see who is writing (setup notes are outside the repo, in `private-docs/SUPPORT.md`).
6. **Realtime on Fly** (`DEPLOY.md` 6). Not a blocker for a closed beta, since polling works, but
   the "sidebar flips to Connected instantly" story depends on it.
7. **Monitoring**: uptime check on `/api/health`, Resend on a paid plan before view emails ramp,
   spend limits on OpenAI, Vercel, Atlas.

## Open product and pricing decisions that touch production

- Price stays $29 Pro. Annual is $290/yr ("$24/mo, billed yearly", two months free). **Built
  2026-09-23** in the sandbox: price `price_1UJ4gXBxWJYhcWkZCk8GKuo9` on the Pro product,
  `STRIPE_PRICE_ID_ANNUAL` in `.env.local`, `POST /api/stripe/checkout { interval: "year" }`, a
  monthly/yearly toggle on `/pricing` and in the upgrade modal, and a "Yearly" button on the
  dashboard plan card. Stripe refuses a Checkout that mixes a yearly price with the monthly metered
  credits price, so an annual subscription has no on-demand: `/api/billing/spend` refuses to turn
  it on and says why, and annual Pro may buy credit packs (`creditPacksAllowed` in
  `src/lib/billing/subscriptionState.ts`). The included credits are still granted monthly (the
  `:m<N>` cycle keys). **Not yet live:** the live-mode price does not exist (DEPLOY 4.2 step 1), and
  `STRIPE_PRICE_ID_ANNUAL` is not set on Vercel, so production offers monthly only until both are
  done and an admin runs the price refresh on `/a/tools/billing`.
- Credit packs were repriced on 2026-09-23 (75/$7, 150/$14, 400/$37). Old pack ids live in
  `RETIRED_CREDIT_PACKS` because the webhook throws after payment otherwise. `DEPLOY.md` 4.2 still
  quotes the old 30/60/300 packs.
- Pro includes 3 collaborators; viewers are free and uncapped. Extra-seat price not chosen.
- Cost instrumentation: `CreditLedger.costUsdActual` is never written, so the real cost of a credit
  is unknown. Token telemetry is captured; a price table at the five charge sites closes it.
- Visit briefs shipped today (Pro-only, 1 credit per brief, cron every 5 min, GPT-4o). First
  production runs will happen as soon as a Pro workspace's link is read.
- Tags → labels rename agreed in principle, deferred.

## Operating notes

- `curl -s https://www.lnkdrp.com/api/health` — `version` is the deployed SHA.
- `vercel ls --prod --scope christian-sanzs-projects` / `vercel inspect <url>` — what is aliased.
  The project lives under `christian-sanzs-projects`; a duplicate once created under another team
  leaked 26 production secrets and failed every build. Do not recreate it elsewhere.
- `npm run admin:list:prod` — who can approve the queue.
- `.env.production.local` is the `vercel env pull` snapshot. It carries the **production
  `MONGODB_URI`** and empty strings for every Sensitive var. Next loads it ahead of `.env.local`
  for `next build`, so a plain local build both fails on missing env and, if it got further, would
  touch production. Delete it when the prod admin scripts are done, or build with `.env.local`
  forced over it (see the memory note "local next build recipe").
- Rollback: `DEPLOY.md` 10. In practice, Vercel → Deployments → promote the previous Ready
  deployment; the previous production deployment before `d8ac1ac` was `0637e1c`
  (`lnkdrp-7r643h4pj`).

## Not verified from here

Atlas tier/backups, Resend domain verification, Google consent-screen status, Vercel plan and
domain configuration screen, cron scheduler runs, Stripe webhook delivery, whether anyone is in
the waitlist queue, OpenAI/Vercel/Atlas spend limits. Each needs the respective dashboard or an
admin session.
