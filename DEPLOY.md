# Deploying lnkdrp

This is the runbook for taking lnkdrp from `main` to production and keeping it there. It covers
the three deployable pieces, the managed services they depend on, the exact environment each
one needs, the order to bring them up, how to verify a release, and how to roll one back.

The older first-deployment checklist with key-generation walkthroughs lives in
`docs/deploy/Deploy_1.md`; this file is the source of truth and links to it where useful.

## 0. Launch sequence

The whole runbook as one ordered list. Each line names the section that has the detail; do them
in this order, because almost every step needs the one before it. Sections 11 and 12 are what
you read after launch and what is deliberately not done.

**A. Before anything — no traffic, one sitting**

- [ ] Accounts and access in hand: Atlas, Vercel **Pro**, Stripe live, Google Cloud, Blob, OpenAI,
      Resend, DNS for the three hosts, `flyctl` logged in (2).
- [ ] Generate the five secrets once and store them (3). `REALTIME_SECRET` goes to three places.
- [ ] `package.json` `engines` → `"22.x"` so Vercel matches the `node:22` service images (2).
- [ ] Local gate on the exact commit you will release: `npx tsc --noEmit -p .`, `npx eslint src
      realtime mcp tests`, the four vitest suites, `npx next build` (9).

**B. Managed services (4)**

- [ ] Atlas: cluster in **us-east-1**, database user, network access, URI **with `/lnkdrp` in the
      path**, Cloud Backup + point-in-time ON, then run the migrations (4.1).
- [ ] Stripe live: Pro $29 price · `ai_credits` meter · $0.10 metered price · webhook with the six
      events and its signing secret · portal saved · revenue recovery on. Then verify both price
      ids with the live key (4.2 step 9) — nothing in the code checks them.
- [ ] Google OAuth: client with the exact callback URI; consent screen External and **In
      production**, or only test users can sign in (4.3).
- [ ] Blob: **public** store, connected to Production only (4.4).
- [ ] OpenAI project key that allows `gpt-4o-mini` (4.5).
- [ ] Resend: `lnkdrp.com` verified (SPF, DKIM, DMARC), API key, From addresses (4.6).

**C. Web app on Vercel (5)**

- [ ] Import the repo, Node 22, domains `lnkdrp.com` and `www` → redirect (5, steps 1–2).
- [ ] Production env: every required row of the table in 5 step 3. Leave `NEXT_PUBLIC_REALTIME_URL`
      **unset** until D is done; the app polls meanwhile.
- [ ] Never set `API_TEST_BYPASS_AUTH`, `API_TEST_USER_ID`, `ADMIN_LOCALHOST_BYPASS`, `DEBUG_*`;
      delete the legacy aliases (5, after the table).
- [ ] Deployment Protection **off** for the production domain, or summary reruns silently never
      start (5 step 5).
- [ ] Deploy (5 step 6).
- [ ] **Cron jobs.** Nothing to configure by hand: `vercel.json` registers all eight on deploy, and
      Vercel sends `CRON_SECRET` from the env as the bearer. Confirm Vercel → Settings → Cron Jobs
      lists exactly these eight (5.1 has flags and leases):

      | Job | UTC schedule | What it does |
      |---|---|---|
      | `notification-emails` | every 5 min | doc-update emails and daily digests, download-request mail |
      | `credits-cycle-reconcile` | hourly :10 | credit cycle grants, Free monthly floor top-up, re-queues skipped summaries |
      | `usage-agg-reconcile` | hourly :20 | rebuilds usage aggregates from the credit ledger |
      | `stripe-credits-report` | hourly :30 | sends on-demand credit usage to the Stripe meter — **this is billing** |
      | `plan-limits` | hourly :40 | Free grace period: start, day-7/day-12 reminders, block, clear |
      | `doc-metrics` | every 6 h | per-document metric snapshots |
      | `stripe-credits-reconcile` | every 6 h :15 | syncs Stripe periods onto subscriptions, backstops cycle grants |
      | `analytics-reconcile` | daily 03:50 | repairs link counter drift; reports page-time overruns as `error` |

      Vercel **Pro is mandatory** — seven of the eight run more than once a day and Hobby rejects
      the file. Not on Vercel Cron? Schedule the same eight with the crontab in 5.1 from one
      always-on host; never two schedulers. The realtime and MCP services have no scheduled work.
- [ ] Existing database only: snapshot, then the nine one-time data jobs in order (5.2). A fresh
      database needs nothing beyond the migrations.
- [ ] Preview environment scoped on its own: sandbox Stripe, its own database and Blob store,
      different secrets (5.3).

**D. Services on Fly (6, 7)**

- [ ] Realtime: `fly launch`, **allocate the egress IP and add it to Atlas before the first
      deploy**, secrets, `fly deploy --ha=false`, cert, CNAME, `/healthz` (6.2).
- [ ] Set `NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com` in Vercel and redeploy the web app
      with a fresh build (6.2).
- [ ] MCP: `fly launch`, `REALTIME_SECRET`, `fly deploy --ha=false`, **exactly one machine**, cert,
      CNAME, `/healthz` (7).
- [ ] Remember the services do not auto-deploy: `fly deploy` again whenever a file listed in 9
      changes.

**E. Verify (8) and hand over**

- [ ] The fourteen release checks in 8, in order. The ones that fail silently without them:
      security headers (1), published consent screen (2), pdf.js fonts (3), index check (4),
      Stripe subscription showing two items (10), every cron `ok` an hour later (14).
- [ ] Make one admin, on a dedicated account that never holds an API key (5.5).

**F. Watch (11) — first week**

- [ ] Uptime monitor on four URLs: `/api/health`, both `/healthz`, and `/api/monitor/crons` with
      `Authorization: Bearer $CRON_SECRET` (200 healthy / 503 not). Point it at the cron monitor
      after the first full round of jobs, not before (11, Crons).
- [ ] Budgets and alerts: OpenAI, Vercel Spend Management, Atlas, Fly; Resend on a paid plan (11,
      Costs).
- [ ] Vercel Firewall rate-limit rule on `/api/*` with the exclusions in 12; the in-app ceilings
      are a floor, not the answer.
- [ ] One test restore of an Atlas snapshot before launch (11, Backups).
- [ ] Read 12: the gaps that are known and deliberately open.

## 1. Topology

```
                     ┌──────────────────────────────────────────────┐
  browser / agent ─▶ │  lnkdrp.com  · Next.js on Vercel             │ ─▶ MongoDB Atlas (replica set)
                     │  web app + REST API + 8 cron routes          │ ─▶ Vercel Blob (PDF storage), Resend (email)
                     └───────────────┬──────────────────────────────┘ ─▶ OpenAI (summary, AI compare)
                                     │ REST with the caller's lnk_ key  ─▶ Stripe (Pro + on-demand credits)
                                     │                                  ─▶ Google OAuth (sign-in)
  MCP client ──────▶ mcp.lnkdrp.com  · Node service (mcp/)  ───────────┘
                     thin translator; no database access

  browser ─────────▶ realtime.lnkdrp.com · Node service (realtime/)  ─▶ MongoDB change streams
  MCP server ──────▶ WebSocket rooms per workspace, HMAC tickets
```

| Piece | Runs on | Why it lives there |
|---|---|---|
| Web app + API + crons | Vercel | Serverless functions, Vercel Cron, Blob client uploads |
| Realtime server | Fly.io machine (`deploy/fly/realtime.fly.toml`); any socket-capable host works | Vercel functions cannot keep a WebSocket open; see 6.1 |
| MCP server | Fly.io machine (`deploy/fly/mcp.fly.toml`) | Long-lived MCP sessions; holds client identity per session |

The web app and the realtime server share one Mongo cluster; all three share one secret family.
Nothing else is stateful.

## 2. Prerequisites

- **MongoDB Atlas** cluster, M10 or larger for change streams under load and for backups (M0
  works for a smoke test). It must be a replica set; Atlas always is.
- **Vercel** project on the **Pro** plan connected to this repository, Node 22 runtime, Fluid
  compute on (the default). Hobby rejects this `vercel.json`: its crons run at most once a day.
  `package.json` `engines` overrides the project setting, and the current `">=22"` deploys the
  latest 24.x; change it to `"22.x"` to match the services images (`node:22-alpine`).
- **Stripe** live account with the catalog from section 4.
- **Google Cloud** OAuth client for sign-in.
- **Vercel Blob** store.
- **OpenAI** API key.
- **Resend** account with the sending domain verified (4.6).
- DNS control for `lnkdrp.com`, `mcp.lnkdrp.com`, `realtime.lnkdrp.com`.
- `flyctl` installed and `fly auth login` done against an org with a payment method (static
  egress IP and always-on machines are billed). Docker is only needed for the non-Fly paths in
  6.3 and 7.

## 3. Secrets

Generate once, store in a password manager, paste into each service's env:

```
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -hex 32      # CRON_SECRET
openssl rand -hex 32      # REALTIME_SECRET   (shared by web app, realtime, mcp)
openssl rand -hex 32      # LNKDRP_SHARE_PASSWORD_SECRET
openssl rand -hex 32      # LNKDRP_ORG_INVITE_TOKEN_SECRET
```

Set the last two before first traffic and change them only after a leak. They fall back to
`NEXTAUTH_SECRET`, but they are encryption keys for stored data: link passwords and pending
invite tokens are saved encrypted with them, so an owner can read a link's password back and a
workspace owner can copy a pending invite URL. Adding one later works like a rotation (11,
Secrets rotation).

## 4. Managed services, in order

### 4.1 MongoDB Atlas

1. Create the cluster on **AWS us-east-1 (N. Virginia)** and a database user with read/write on
   `lnkdrp` (it includes the `changeStream` action realtime needs). Vercel functions run in
   `iad1` (Settings → Functions → Function Region; leave it there) and both Fly apps in `iad`; a
   cluster anywhere else adds latency to every request.
2. Network access: allow Vercel's egress (or `0.0.0.0/0` with a strong password, which is what
   Vercel recommends) and the realtime host's egress IP (on Fly, allocate one first; see 6.2).
   The MCP server never talks to Atlas.
3. Copy the URI with the database name in the path:
   `mongodb+srv://user:pass@cluster.x.mongodb.net/lnkdrp?retryWrites=true&w=majority`. Atlas's
   Connect string has no database path; add `/lnkdrp`. This is `MONGODB_URI` for the web app and
   the realtime server. The MCP server takes none.
4. Backups: turn on Cloud Backup and Continuous Cloud Backup (point-in-time restore) before any
   real customer data exists. M0 has no backups. Before every migration run or one-time data job
   against a database with real data, take an on-demand snapshot (Atlas → Backup → Take Snapshot
   Now) and write its time down. Migrations and data jobs have no down step; restoring that
   snapshot is the only undo (11, Backups).
5. Run migrations from a trusted machine with that URI in the environment:
   ```
   MONGODB_URI='mongodb+srv://…/lnkdrp' node db/migration/run.mjs --dry-run
   MONGODB_URI='mongodb+srv://…/lnkdrp' node db/migration/run.mjs
   ```
   `--dry-run` only lists migration files; it does not connect. The real run prints
   `skip (already applied)` or `run:` for each file, so read that output. Migrations create and
   drop indexes and also rewrite data (orgId backfills, personal-org dedupe, `$unset` of null
   `slug`, `personalForUserId` and `claimTokenHash`). Two of them replace a unique+sparse index
   with a partial one (`20260911_0001` for `orgs.slug`, `20260915_0001` for
   `orgs.personalForUserId`); without the second, the *second* team workspace in the database
   fails with E11000, reported to the user as "An org with that slug already exists". Applied ones are recorded in the `migrations` collection and
   skipped on re-run. A failing migration (for example E11000 while building a unique index)
   stops the runner at that file; a re-run resumes there once the data is fixed.

### 4.2 Stripe (live mode)

Mirror the sandbox catalog, which is already correct. Ids for the sandbox are in
`docs/SUBSCRIPTION.md`; the live ones will differ.

1. Product **Pro** with one recurring licensed price: $29 / month. Description:
   "Unlimited share links and projects, deep viewer analytics, a version list recipients can
   browse, 1 collaborator included, and 300 AI credits a month (about 60 standard AI compares)."
   No unit label. Earlier revisions of this runbook said "version history with AI compare" and
   "Summaries never use credits"; both stopped being true on 2026-09-13 (the summary costs 1
   credit and version history with AI compare runs on credits on every plan). If the sandbox
   product was created from that text, update it as well. Checkout shows a promotion code field,
   so every active live promotion code applies to Pro; create codes deliberately.
2. Billing Meter **AI credits (on-demand)**: event name `ai_credits`, aggregation sum, customer
   mapped by `stripe_customer_id`, value key `value`.
3. Product **On-demand AI credits** with one metered monthly price at $0.10 per unit on that
   meter, unit label `credit`. Metadata `type=ai_credits`. This price is attached to every Pro
   subscription at checkout; the app reports one meter unit per credit only when a workspace has
   turned on-demand on.
4. Webhook endpoint `https://lnkdrp.com/api/stripe/webhook` with these events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
5. Customer portal (live mode): enable cancel, payment-method update and invoice history. Turn
   **off** subscription updates (switch plans, change quantity): the app sells one Pro seat at
   quantity 1 and ignores quantity, so a change only raises the bill. Click Save once; until the
   live configuration is saved, `/api/stripe/portal` returns 400 and Manage subscription fails.
   The app sets the return URL on every session (`NEXT_PUBLIC_APP_URL` + `/dashboard?tab=overview`).
6. Revenue recovery (Billing settings, live mode): turn on Smart Retries and the failed-payment
   email, and cancel the subscription after the last retry. The app treats only `active` and
   `trialing` as Pro. A failed renewal moves the subscription to `past_due`, which drops the
   workspace to Free limits and turns on-demand off at once. It returns to Pro on the next
   successful payment (`invoice.paid`); on-demand stays off until an owner turns it on again.
7. Env: `STRIPE_SECRET_KEY` (sk_live), `STRIPE_PRICE_ID` (the $29 price),
   `STRIPE_AI_CREDITS_PRICE_ID` (the $0.10 price). `STRIPE_CREDITS_METER_EVENT_NAME` defaults to
   `ai_credits`; set it only if the live meter uses another event name.
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is optional; no current page reads it.
8. Set `STRIPE_AI_CREDITS_PRICE_ID` before the first live Checkout. Nothing checks it at startup.
   Without it Checkout still sells Pro, but with no metered item; workspaces can still turn
   on-demand on and spend credits, and `stripe-credits-report` never sends that usage to Stripe.
   Setting the variable later does not fix existing subscriptions: add the $0.10 price to each
   one in Stripe; the `customer.subscription.updated` event that follows links it. Resending an
   old event does nothing, the webhook skips events it already processed.
9. Before the first production deploy, check both ids with the live key:
   ```
   curl -s https://api.stripe.com/v1/prices/$STRIPE_PRICE_ID -u "$STRIPE_SECRET_KEY:"
   curl -s https://api.stripe.com/v1/prices/$STRIPE_AI_CREDITS_PRICE_ID -u "$STRIPE_SECRET_KEY:"
   ```
   Both must return a price with `"livemode": true`; a sandbox id returns `No such price`. The
   credits price must show `recurring.usage_type` `metered` and `recurring.meter` equal to the id
   of the meter whose `event_name` is `ai_credits`. The code checks neither: a sandbox id fails
   only when a customer clicks Upgrade, and a price on another meter accepts usage that never
   reaches an invoice.

Keep the sandbox for the preview environment (5.3); never point a preview at live keys.

### 4.3 Google OAuth

Web client with authorised redirect URI `https://lnkdrp.com/api/auth/callback/google`. On Vercel,
NextAuth builds the callback from the request host, not `NEXTAUTH_URL`, so sign-in works only on
hosts listed here; the production `*.vercel.app` URL fails with `redirect_uri_mismatch`. Google
accepts no wildcards and every preview deployment URL is new, so for previews list a stable host
(a branch URL or `staging.lnkdrp.com`). Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Anyone
with a Google account can sign in; there are no invite codes.

OAuth consent screen: user type **External**, scopes `openid`, `email`, `profile` only, app
domain and privacy/terms links set to `https://lnkdrp.com/privacy` and `https://lnkdrp.com/tos`,
and publishing status **In production**. While the app is still "Testing", only the listed test
users can sign in and everyone else gets an access error, which looks like a broken login.

### 4.4 Vercel Blob

Create a store with **public** access. Every write uses `access: "public"`, and production accepts
only URLs on `<storeId>.public.blob.vercel-storage.com`, derived from `BLOB_READ_WRITE_TOKEN`.
Connect the store to Production only and give Preview its own store; with one store on every
environment, preview uploads land beside production files and each environment accepts the
other's URLs. Copy `BLOB_READ_WRITE_TOKEN`.

Uploads go browser → Blob with a token minted by `/api/blob/upload`: PDF up to 250 MB and the page
preview PNG under `docs/`, PNG/JPEG/WebP under `org-avatars/`. The browser tells the app when an
upload is done; the app registers no Blob completion callback, so `VERCEL_BLOB_CALLBACK_URL` is
not used.

### 4.5 OpenAI

`OPENAI_API_KEY`. All tiers currently use `gpt-4o-mini`; the tier changes depth, not model.
Without the key uploads still complete and links work, but every AI summary is skipped (no credit
is charged), so check it before announcing anything. Use a project key; if the project restricts
models, allow `gpt-4o-mini`. A refused or budget-capped call does not fail the upload either: the
document completes without a summary.

### 4.6 Email (Resend)

Every outbound email goes through Resend's HTTP API: a confirmation to the requester and a notice
to the owner on a download request, the approval link to the requester, doc-update emails
(immediate, or a daily digest after 23:00 UTC), plan-limit grace emails and workspace invites.

1. Add the sending domain `lnkdrp.com` in Resend and create the DNS records it asks for (SPF and
   DKIM, plus a DMARC record if the domain has none). Wait for "Verified"; unverified domains
   silently drop to spam or fail.
2. Create an API key with send access. Env on the web app: `RESEND_API_KEY`,
   `NOTIFICATION_EMAIL_FROM` (`LinkDrop <hi@lnkdrp.com>`), `INVITE_EMAIL_FROM` (same, or a
   dedicated address). Invites read only `INVITE_EMAIL_FROM`; everything else uses
   `NOTIFICATION_EMAIL_FROM`, falling back to `INVITE_EMAIL_FROM`. No email sets a Reply-To, so
   replies go to the From address: give it a real inbox.
3. Leave `EMAIL_TRANSPORT` **unset** in production. `EMAIL_TRANSPORT=console` logs instead of
   sending and is for local development, but invites ignore it and always call Resend. Without
   `RESEND_API_KEY`, sending throws.

## 5. Web app on Vercel

1. Import the repository; framework preset Next.js; root directory `/`; Node 22 (see 2 on
   `engines`; confirm with `process.version` in a function log).
2. Domains: `lnkdrp.com` (primary) and `www.lnkdrp.com` redirecting to it.
3. Environment variables (Production; Preview is in 5.3). Required unless marked optional.
   `.env.example` is the development template and is incomplete for production; this table is
   the source of truth.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://lnkdrp.com` |
| `NEXTAUTH_URL` | `https://lnkdrp.com` |
| `NEXTAUTH_SECRET` | generated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from 4.3 |
| `MONGODB_URI` | from 4.1, with `/lnkdrp` in the path |
| `BLOB_READ_WRITE_TOKEN` | from 4.4 |
| `OPENAI_API_KEY` | from 4.5 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_AI_CREDITS_PRICE_ID` | from 4.2; a missing credits price fails silently (4.2 step 8) |
| `CRON_SECRET` | generated; Vercel Cron sends it as `Authorization: Bearer` automatically |
| `REALTIME_SECRET` | generated; same value on the services host |
| `NEXT_PUBLIC_REALTIME_URL` | `wss://realtime.lnkdrp.com` (leave unset until section 6 is live; the app polls meanwhile) |
| `NEXT_PUBLIC_APP_URL` | `https://lnkdrp.com`; Stripe Checkout and portal return URLs are built from it (falls back to the request origin, which is wrong behind a preview or proxy) |
| `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `INVITE_EMAIL_FROM` | from 4.6; leave `EMAIL_TRANSPORT` unset |
| `LNKDRP_SHARE_PASSWORD_SECRET`, `LNKDRP_ORG_INVITE_TOKEN_SECRET` | generated (3); rotate only after a leak |
| `ERROR_LOGGING_ENABLED` | `true`. The default is off outside development, so production records nothing in `errorevents` without it |
| `STRIPE_CREDITS_METER_EVENT_NAME` | optional; defaults to `ai_credits` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | optional; no current page reads it (Checkout is created on the server) |
| `NEXT_PUBLIC_MCP_URL` | optional; default `https://mcp.lnkdrp.com/mcp`. Without it, `/connect` shows `http://localhost:8787/mcp` on any origin other than `NEXT_PUBLIC_SITE_URL` (a `*.vercel.app` or preview URL) |
| `MONGODB_DB_NAME` | leave unset. The realtime server ignores it and takes the database from the URI path. A URI without `/lnkdrp` plus this variable makes realtime watch another database: sockets connect, `/healthz` is ok, and no live events arrive |
| `BLOB_BASE_URL` | optional; the store host is derived from `BLOB_READ_WRITE_TOKEN`. Production refuses blob URLs from any other store when neither identifies it |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | optional; leave unset. They apply only when both are set; one alone is ignored and both redirects come from `NEXT_PUBLIC_APP_URL` |
| `NEXT_PUBLIC_FEATURE_CREDITS` | optional; credits UI is on by default, `0` hides it |
| other `ERROR_LOGGING_*` | optional; see `docs/ERROR_LOGGING.md` |

`NEXT_PUBLIC_*` values are inlined at build time into the browser bundle and the server routes
(the realtime ticket, Stripe return URLs, email links). After changing one, redeploy with a fresh
build. Promoting an older deployment brings back the values it was built with. Any other Vercel
env change also reaches functions only on the next deployment.
`NEXTAUTH_SECRET` also signs the short-lived server-to-server token the app uses to re-run
processing (writing a skipped summary, the Free monthly re-queue), so rotate it on a deploy, not
mid-traffic.

Never set `API_TEST_BYPASS_AUTH`, `API_TEST_USER_ID` or `ADMIN_LOCALHOST_BYPASS` in production.
The auth bypass is refused whenever `NODE_ENV=production` (Vercel production, previews and
`next start`), but do not rely on that. Delete the legacy aliases `LNKDRP_CRON_SECRET` and
`STRIPE_USAGE_PRICE_ID`; the code still reads them when the current name is unset. Leave
`DEBUG_LEVEL`, `DEBUG_MODE` and `NEXT_PUBLIC_DEBUG_LEVEL` unset: at level 1 or higher,
`GET /api/docs/:id?debug=1` returns the raw document record, including password hash fields, to
any member who can open the doc, and logs turn verbose. Debug on a preview instead.

The admin API has a second bypass that needs no flag: outside `NODE_ENV=production`, any request
whose `Host` header starts with `localhost:` or `127.0.0.1:` is an admin on every `/api/admin/*`
route (one shared gate, `src/lib/gating/requireAdmin.ts`), including deleting users and
workspaces and changing credits. A browser tab on any website can send such a request to a
running `next dev`. So never run `next dev` against a shared or production database, never expose
it through a tunnel that rewrites the host header (for example `ngrok --host-header=rewrite`),
and never serve staging from `next dev`. `ADMIN_LOCALHOST_BYPASS=0` turns it off in development
when you need the real gate.

4. Crons come from `vercel.json`; see 5.1. **Vercel Pro is required** because seven of the eight
   jobs run more than once a day (`notification-emails` every 5 minutes). PDF processing, URL
   import, uploads, compare reruns and all eight cron routes declare `maxDuration = 300`.
   Processing continues in `after()` inside that same 300 s budget, so a deck that cannot be
   processed in 5 minutes fails on any plan unless `maxDuration` is raised (Pro with Fluid compute
   allows up to 800 s).
5. Deployment Protection: keep **Vercel Authentication off for the production domain**. The app
   calls its own `/api/uploads/:id/process` from the server (summary rerun, Free monthly re-queue
   from the `credits-cycle-reconcile` cron); a protected deployment answers those calls with a
   login page and the reruns silently never start. Protection on previews is fine; those two
   features simply do not work there.
6. Deploy. The first production build takes a few minutes because of the PDF and canvas native
   packages.

### 5.1 Cron jobs

Every job is one HTTP route, one schedule, one runner script (`scripts/cron/cron.<job>.ts`) and
one `cron:<job>` npm script, and `tests/lib/cronMap.test.ts` fails when they drift:

| Job | Schedule (`vercel.json`, UTC) | `--dry-run` | Lease |
|---|---|---|---|
| `doc-metrics` | `0 */6 * * *` | ignored | no |
| `stripe-credits-reconcile` | `15 */6 * * *` | ignored | yes |
| `stripe-credits-report` | `30 * * * *` | ignored | yes |
| `credits-cycle-reconcile` | `10 * * * *` | yes | no |
| `usage-agg-reconcile` | `20 * * * *` | ignored | no |
| `notification-emails` | `*/5 * * * *` | yes | yes |
| `plan-limits` | `40 * * * *` | yes | yes |
| `analytics-reconcile` | `50 3 * * *` | yes | no |

Never pass `--dry-run` to a job marked "ignored" expecting a preview: the runner still adds
`?dryRun=1`, the route ignores it and does the real work, including Stripe meter events and credit
grants.

- **Production:** Vercel Cron calls `GET /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`
  on the schedule. Every route records a `CronHealth` row and accepts `POST` as well. The four
  jobs marked "Lease" hold a Mongo lease (6 minutes) and answer `{ skipped: "locked" }` while
  another run holds it. The other four have no lease but are idempotent, so a double run repeats
  work without double-granting or double-sending.
- **By hand, any environment:** from a checkout,
  `CRON_SECRET='…' npx tsx scripts/cron/cron.<job>.ts --target=https://lnkdrp.com` (add
  `--dry-run` only where the table says yes, `--limit=N` to shrink a run). Do not use
  `npm run cron:<job>` against production: the alias loads `--env-file=.env.local`, exits with
  `.env.local: not found` where that file is missing, and without `--target` calls
  `CRON_TARGET_URL`, then `NEXT_PUBLIC_SITE_URL`, then `http://localhost:3001`. Without a
  checkout, use curl: `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/<job>`.
  Against a local dev server the secret is optional. The runners only call the route; they never
  re-implement a job.
- **Without Vercel Cron:** the Fly images contain neither the runners nor the repo, so schedule
  the routes with curl from any always-on host. Vercel schedules are UTC; set the host or
  `CRON_TZ=UTC` to match:
  ```
  CRON_SECRET=…
  0 */6 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/doc-metrics
  15 */6 * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/stripe-credits-reconcile
  30 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/stripe-credits-report
  10 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/credits-cycle-reconcile
  20 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/usage-agg-reconcile
  */5 * * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/notification-emails
  40 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/plan-limits
  50 3 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/analytics-reconcile
  ```
  `scripts/cron/README.md` leaves `analytics-reconcile` out of its crontab, and its lines need
  `.env.local`; use this list. Keep the schedules identical to `vercel.json` and run one scheduler
  only: a second one is skipped by the leased jobs and only repeats work in the others.
- Job details and manual-trigger examples: `docs/CRON.md` (it predates `analytics-reconcile`).

### 5.2 One-time data jobs

A fresh production database needs only the migrations (4.1). If production starts from a
database that already holds documents, take an Atlas snapshot first (4.1 step 4), then run these
once, in order, from a trusted machine, before announcing the release. Each is idempotent. The
flags differ: steps 4 and 5 **write unless you pass `--dry-run`**; steps 2, 3 and 6 to 8 only
preview unless you pass `--apply`. Always run the preview form first and read its output. The
`npm run` aliases hard-code `--env-file=.env.local`, so call the scripts directly with a
production env file:

| Step | Command | What it fixes |
|---|---|---|
| 1 | `node --env-file=prod.env db/migration/run.mjs` | Indexes and data migrations, including `sharelinks` (20260913). Without `--env-file` (or the inline `MONGODB_URI=` of 4.1) the runner reads `.env.local` and migrates that database instead |
| 2 | `node --env-file=prod.env scripts/project-shareid-backfill.mjs`, then `--apply` | Projects from before public project links have no `shareId`; the unique index cannot build and `/p/:shareId` fails for them |
| 3 | `node --env-file=prod.env scripts/project-doc-count-recount.mjs`, then `--apply` | Recomputes the cached `Project.docCount` shown in project lists |
| 4 | `npx tsx --env-file=prod.env scripts/sharelinks-backfill.ts` (`--dry-run` first) | Creates the default share link row for documents from before multiple links. `problems` must be empty; `no orgId` means step 1 did not run against this database |
| 5 | `npx tsx --env-file=prod.env scripts/sharelinks-analytics-backfill.ts` (`--dry-run` first) | Gives old analytics rows their `shareLinkId`, `orgId` and `lastViewedAt`, flags owner previews and reconciles link counters. Runs only after step 4: it attributes rows to the links step 4 creates. `after` must be all zeros, `orphanShareIds` and `mismatches` empty; a second run reports zero |
| 6 | `npx tsx --env-file=prod.env scripts/docchange-from-upload-repair.ts`, then `--apply` | Old version-change rows pointed "from" at the new upload |
| 7 | `npx tsx --env-file=prod.env scripts/credit-balances-reconcile.ts`, then `--apply` | Team workspaces seeded with Free starter credits; Free workspaces missing the 15-a-day cap. Add `--reset-compare-tier` only if no Free user has chosen a compare tier on purpose: it moves every Free row stored as "standard" back to the plan default (a replacement cost 6 instead of 3) |
| 8 | `npx tsx --env-file=prod.env scripts/ai-ask-repair.ts`, then `--apply` | Stored summaries with an operating cost taken as the funding ask, and invented "Funding ask"/milestone metrics |
| 9 | `npx tsx --env-file=prod.env scripts/verify-share-analytics.ts` | Must print "All share-analytics invariants hold" (see 9.1) |

`scripts/request-docs-projectids-backfill.mjs` and `scripts/doc-received-via-request-backfill.mjs`
repair Requests data. Requests are hidden at launch; run them (same form, dry run then `--apply`)
before turning `NEXT_PUBLIC_FEATURE_REQUESTS` on.

`prod.env` is a local file with at least `MONGODB_URI`; keep it out of the repository and delete it
afterwards. `--env-file` never overrides a variable already set in your shell: run the jobs in a
fresh shell, or prefix each command with `env -u MONGODB_URI -u MONGODB_DB_NAME`, and check the
preview output shows production-sized counts before applying.

### 5.3 Preview environment

Scope every variable to Production or Preview on its own. Never use All Environments for these:

| Variable | Preview value |
|---|---|
| `NEXT_PUBLIC_SITE_URL`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | a stable preview host (a branch URL or `staging.lnkdrp.com`, also listed in Google, 4.3), never `https://lnkdrp.com`. Share URLs, Stripe returns and email links are built from them |
| `MONGODB_URI` | a separate Atlas database |
| `STRIPE_*`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | sandbox keys and prices, and a sandbox webhook to the preview host (it fails while Vercel Authentication protects that host) |
| `BLOB_READ_WRITE_TOKEN` | a separate Blob store (4.4) |
| `NEXTAUTH_SECRET`, `CRON_SECRET`, `REALTIME_SECRET`, `LNKDRP_*_SECRET` | different from production |
| `NEXT_PUBLIC_REALTIME_URL` | unset (previews poll) |
| `ERROR_LOGGING_ENABLED`, `ERROR_LOGGING_ALLOWED_ENVS` | `true` and `preview`, only if you want preview errors recorded |

### 5.4 Index check

Migrations create only some indexes. Mongoose `autoIndex` is on, so every function builds the rest
of the model indexes at cold start. A unique index that hits duplicate data fails **silently**,
and the guarantee it gives (Stripe webhook dedupe, credit grant idempotency, one balance per
workspace) is gone. Run this after the first real traffic (8 step 4) and after every release that
changes `src/lib/models/`:

```
mongosh "$MONGODB_URI" --quiet --eval '
const want = {
  stripeevents: ["eventId_1"],
  creditledgers: ["workspaceId_1_idempotencyKey_1", "workspaceId_1_eventType_1_cycleKey_1"],
  workspacecreditbalances: ["workspaceId_1"],
  subscriptions: ["orgId_1"],
  apikeys: ["keyHash_1"],
  cronhealths: ["jobKey_1"],
  orgs: ["personalForUserId_1", "slug_1"],
  orgmemberships: ["orgId_1_userId_1"],
  users: ["email_1"],
  docs: ["shareId_1"],
  projects: ["shareId_1"],
  docChanges: ["docId_1_toVersion_1", "docId_1_toUploadId_1"],
  sharelinks: ["shareId_1"],
  shareviews: ["shareId_1_botIdHash_1"],
  sharevisits: ["shareId_1_botIdHash_1_visitIdHash_1"],
  usageaggdailies: ["workspaceId_1_day_1"],
  usageaggcycles: ["workspaceId_1_cycleKey_1"],
  ratelimits: ["key_1", "expiresAt_1"],
  errorevents: ["createdAt_1"],
};
for (const [c, names] of Object.entries(want)) {
  let have;
  try { have = db.getCollection(c).getIndexes().map((i) => i.name); } catch (e) { print("NO COLLECTION", c); continue; }
  for (const n of names) if (!have.includes(n)) print("MISSING", c, n);
}
// Two orgs indexes must be *partial*, not sparse: sparse still indexes an explicit null, which is
// what broke the second team workspace. A name check alone cannot see this.
for (const n of ["slug_1", "personalForUserId_1"]) {
  const i = db.orgs.getIndexes().find((x) => x.name === n);
  if (i && !i.partialFilterExpression) print("NOT PARTIAL", "orgs", n, "- migration did not run");
}'
```

No output means every index is there. `NO COLLECTION` is fine before that feature has been used.
For each `MISSING`, run the same `createIndex` by hand in mongosh to see the error. An E11000 names
the duplicate key: fix or merge those rows (snapshot first), then re-run. The `projects`
`{userId, name}` and `{userId, slug}` indexes and the model's `orginvites` partial index never
build (MongoDB rejects `$exists:false` and `$ne` in partial filters); that is expected and not
listed above.

### 5.5 Admins

Admin tools are `/a` (cron health, credits, data, AI runs) and `/api/admin/*`. An admin is a
`users` row with `role: "admin"`. Nothing in the app grants it.

1. Sign in once with the admin's Google account.
2. From a trusted machine:
   ```
   mongosh "$MONGODB_URI" --eval 'db.users.updateOne({ email: "ops@lnkdrp.com" }, { $set: { role: "admin" } })'
   ```
3. Sign out and back in. The API reads the role from the database on every call, but the `/a`
   pages read it from the session, which only reloads on sign-in.
4. Use a dedicated admin account anyway. `/api/admin/*` refuses any actor that came from an API
   key (`src/lib/gating/requireAdmin.ts`, 403 "API keys cannot access admin endpoints"), before
   the role lookup so a stolen key cannot learn whether its owner is an admin by comparing
   replies. That gate is the only thing standing between an admin's `lnk_` key and every user's
   data, so do not make it the only thing: keep the admin account separate from the account that
   connects agents.

To remove an admin, set `role` back to `"user"`. The API stops accepting them on the next call.
Keep the list short.

## 6. Realtime server

### 6.1 Where to host WebSockets

The web app cannot host them: Vercel functions are request-scoped and cannot keep a socket open.
The server needs a host that runs a container continuously, passes WebSocket upgrades through
its edge, does not idle-close connections faster than our 25 s heartbeat, and reaches Atlas.
Options weighed (September 2026):

| Host | WebSockets | Notes | Fit |
|---|---|---|---|
| **Fly.io** | Native; TLS terminated by fly-proxy, sockets forwarded to the machine | Built for long-running processes; a `shared-cpu-1x` machine runs about $2/month, custom domains $0.10/month with the first ten free; `auto_stop_machines` must be off. Launch plan $5/month. | **Recommended**: cheapest always-on option with first-class socket support and per-app certificates. `deploy/fly/*.toml` are ready. |
| Railway | Supported; automatic SSL, deploy from GitHub | Usage-billed; a 512 MB Node service is a few dollars a month; Hobby $5 with $5 credit, Pro $20. | Good alternative if you prefer GitHub-push deploys over `fly deploy`. |
| Render | Supported; no fixed idle timeout, connections drop on redeploy | Free tier spins down (useless for sockets); paid instances from about $7/month. | Fine; slightly pricier, simple UI. |
| DigitalOcean App Platform | Supported but idles sockets after roughly 1–2 minutes of inactivity | Our 25 s ping keeps connections alive, but the platform publishes little socket guidance. | Workable, not preferred. |
| A VM (Hetzner, DigitalOcean Droplet) + Caddy | Anything | $4–6/month, you run TLS, updates and restarts; `deploy/docker-compose.yml` fits this. | Fine if you already operate a box. |
| Managed pub/sub (Ably, Pusher) | Yes | Would replace `realtime/server.ts` and the browser client with their SDK; pay per connection/message. | Not now; ours is one small process. |

Decision: **Fly.io**, one machine each for realtime and MCP in `iad` (closest to Vercel's default
region and to Atlas in us-east-1, 4.1). Both configs live in `deploy/fly/`. Move to Railway or a VM
by reusing the same Dockerfiles; nothing in the code is Fly-specific.

### 6.2 Deploy on Fly

Run every `fly` command from the repository root: both Dockerfiles build from there, because each
imports a module or two out of `src/lib`. The root `.dockerignore` keeps `node_modules`, `.next`,
`.git` and every `.env*` out of the context, so a working checkout is safe to deploy from — but
whatever you add to it, keep the paths those Dockerfiles `COPY` out of the ignore list, or the
build fails on a missing file.

```
fly launch --no-deploy --copy-config --config deploy/fly/realtime.fly.toml \
  --dockerfile realtime/Dockerfile --name lnkdrp-realtime
fly ips allocate-egress -a lnkdrp-realtime -r iad   # static outbound IPv4, $3.60/month
fly ips list -a lnkdrp-realtime                     # add the egress IPv4 to the Atlas allowlist
fly secrets set MONGODB_URI='mongodb+srv://…/lnkdrp' REALTIME_SECRET='…' -a lnkdrp-realtime
fly deploy --ha=false --config deploy/fly/realtime.fly.toml --dockerfile realtime/Dockerfile
fly scale show -a lnkdrp-realtime                   # expect one machine
fly certs add realtime.lnkdrp.com -a lnkdrp-realtime    # then CNAME realtime → lnkdrp-realtime.fly.dev
curl https://realtime.lnkdrp.com/healthz
```

- Fly outbound IPs change unless allocated as above, and without an allocation `fly ips list`
  shows only inbound addresses. Add the egress IP to Atlas before the first deploy, or allow
  `0.0.0.0/0` with a strong password. Without it the server exits on start and Fly restarts it in
  a loop (`fly logs -a lnkdrp-realtime` shows `[realtime] fatal`); a good start logs
  `mongo connected`.
- `MONGODB_URI` must end in `/lnkdrp`: the realtime server does not read `MONGODB_DB_NAME`.
- The server checks only `MONGODB_URI` at boot. Without `REALTIME_SECRET` `/healthz` answers, but
  the first browser connection crashes the machine; a secret that differs from Vercel's rejects
  every socket with 401. 8 step 7 catches both.
- `fly deploy` creates two machines on an app's first deploy unless `--ha=false` is passed. Two
  realtime machines work but double the change streams; for MCP see 7. If `fly scale show`
  reports two, run `fly scale count 1 -a <app>`.

Then set `NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com` in Vercel and redeploy the web app.
Until then the app polls and everything still works.

### 6.3 Deploy with Docker anywhere else

Host it anywhere that can keep a WebSocket open and reach Atlas. Single instance for launch. Add
`--platform linux/amd64` to `docker build` when you build on one machine (an Apple Silicon Mac)
and run on another.

```
docker build -f realtime/Dockerfile -t lnkdrp-realtime .
docker run -d --restart unless-stopped -p 8788:8788 \
  -e MONGODB_URI='mongodb+srv://…/lnkdrp' -e REALTIME_SECRET='…' lnkdrp-realtime
```

Or with the compose file that runs both services. Put `MONGODB_URI`, `REALTIME_SECRET`,
`LNKDRP_API_URL`, `MCP_PUBLIC_URL` and `NEXT_PUBLIC_REALTIME_URL` in `.env.production.services` at
the repository root, then run from the repository root:

```
docker compose -f deploy/docker-compose.yml --env-file .env.production.services up -d --build
```

Without `--env-file` Compose looks for `deploy/.env`, the secrets are empty and realtime exits on
start.

Put TLS in front (Caddy, nginx, the host's load balancer) so the public address is
`wss://realtime.lnkdrp.com`; the proxy must pass WebSocket upgrades and keep idle connections
longer than 30 seconds (the server pings every 25). Verify with `/healthz`, then set
`NEXT_PUBLIC_REALTIME_URL` in Vercel as above.

Details, frame formats and scaling notes: `docs/REALTIME.md`.

## 7. MCP server

Same host class as the realtime server; on Fly, from the repository root (6.2). It never talks to
Atlas, so it needs no egress IP for the allowlist (12 covers the rate-limit case):

```
fly launch --no-deploy --copy-config --config deploy/fly/mcp.fly.toml --dockerfile mcp/Dockerfile --name lnkdrp-mcp
fly secrets set REALTIME_SECRET='…' -a lnkdrp-mcp
fly deploy --ha=false --config deploy/fly/mcp.fly.toml --dockerfile mcp/Dockerfile
fly scale show -a lnkdrp-mcp                            # must be exactly one machine
fly certs add mcp.lnkdrp.com -a lnkdrp-mcp              # then CNAME mcp → lnkdrp-mcp.fly.dev
```

Or with Docker anywhere (add `--platform linux/amd64` as in 6.3):

```
docker build -f mcp/Dockerfile -t lnkdrp-mcp .
docker run -d --restart unless-stopped -p 8787:8787 \
  -e NODE_ENV=production -e LNKDRP_API_URL=https://lnkdrp.com \
  -e MCP_PUBLIC_URL=https://mcp.lnkdrp.com \
  -e NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com -e REALTIME_SECRET='…' \
  lnkdrp-mcp
```

1. TLS in front so clients reach `https://mcp.lnkdrp.com/mcp`. Sessions are held in memory,
   so run exactly one instance or use sticky sessions on `Mcp-Session-Id`. A second machine
   without sticky routing answers `404 Session not found` to agents at random; on Fly fix it with
   `fly scale count 1 -a lnkdrp-mcp`.
2. `GET https://mcp.lnkdrp.com/healthz` → `{ ok: true, sessions, version, apiUrl }`.
3. The public guides at `https://lnkdrp.com/mcp/<client>` already point clients here.

The server has no database access: every tool call is a REST call to the web app with the
caller's own key. Details: `docs/MCP.md`.

## 8. Verify the release

Run in this order; each step depends on the previous.

1. `curl https://lnkdrp.com/api/health` → 200 with `"ok":true`, `"mongo":"ok"`,
   `"env":"production"`, and `"version"` equal to `git rev-parse --short HEAD` of the commit you
   released. Then `curl -sI https://lnkdrp.com/s/<shareId> | grep -iE 'frame|content-type-options|referrer'`
   → all four security headers (11, Security headers). They come from `next.config.ts`, so a
   deployment that lost them looks completely normal otherwise.
2. Sign in with Google with an account that is not on the OAuth test-user list (proves the consent
   screen is published). A personal workspace is created on first sign-in, on Free, with
   **50 AI credits** in the sidebar.
3. Upload a PDF, open the share link in a private window, confirm the summary renders, the
   sidebar drops to **49 credits**, and the view shows in the doc's quick stats and as a
   "Someone viewed" row on `/activity` without a reload. Use a PDF with non-embedded fonts (a Word
   export with Helvetica or Times) and check the page previews show text — that is what proves
   pdf.js's `standard_fonts`, `cmaps` and `wasm` folders were traced into the function, which
   nothing else in this list exercises and which fails silently.
4. Run the index check in 5.4; it must print nothing.
5. Replace the file once: expect the AI compare on `/doc/:id/history` and **46 credits** (summary 1
   plus basic compare 2).
6. Open `/connect`, create a key, run the Verify curl. The pill reads "Key verified".
7. `curl https://realtime.lnkdrp.com/healthz` shows `sockets` of at least 1 while your tab is open.
   Then, with DevTools → Network → WS open on `/activity`, open the share link again: an `activity`
   frame arrives within a second. A row that appears only after several seconds is polling, and
   realtime is not working.
8. Add the MCP to Claude Code with that key, open a session; the sidebar Agents entry flips to
   "1 connected" with the client listed under it, without a click. Ask it to share a PDF by URL
   and confirm the link. Or run the harness against production from a trusted machine:
   `MONGODB_URI='mongodb+srv://…/lnkdrp' E2E_ORG_ID=<your workspace id> E2E_USER_ID=<your user id> MCP_URL=https://mcp.lnkdrp.com/mcp npx tsx tests/mcp/e2e.ts`.
   It mints and revokes its own key directly in that database and deletes the docs it creates; it
   spends real credits in that workspace and leaves activity rows. Without the two ids it uses the
   local dev workspace ids and fails. Its first step checks headroom: on a Free workspace it needs
   one open document slot (it creates a second document only after releasing the first) and stops
   there with the numbers rather than failing twenty steps in with a `plan_limit` that reads like
   a broken tool. Archive a document or use a Pro workspace. Its last line is a JSON summary
   with the step count; exit 0 is the pass.
9. Trigger one cron by hand and confirm 200:
   `curl -X POST https://lnkdrp.com/api/cron/plan-limits -H "Authorization: Bearer $CRON_SECRET"`.
   Then the analytics reconcile, which reports rather than just succeeding:
   `CRON_SECRET='…' npx tsx scripts/cron/cron.analytics-reconcile.ts --dry-run --target=https://lnkdrp.com`.
   Expect `linksReconciled: 0` and `pageTimeOverruns: 0` on a healthy deploy; see 9.1.
10. Stripe: buy Pro with a real card, confirm the subscription shows in the dashboard, the credits
    read 300, the Stripe return lands on `https://lnkdrp.com` (not a preview URL), and the webhook
    delivery log shows `checkout.session.completed` handled. The subscription must show two items,
    Pro and On-demand AI credits; only Pro means `STRIPE_AI_CREDITS_PRICE_ID` was missing on that
    deployment (4.2 step 8). Cancel it from the portal and refund the charge in the Stripe
    dashboard.
11. Email: request a download on a link with downloads off, from a private window; the owner
    receives the notice from `NOTIFICATION_EMAIL_FROM` in the inbox, not spam.
12. Recreate `prod.env`, run `npx tsx --env-file=prod.env scripts/verify-share-analytics.ts`
    against production (read-only), and delete the file again.
13. Revoke the test key from `/connect`; the sidebar returns to Not connected.
14. Vercel → Settings → Cron Jobs lists 8 jobs. An hour after the deploy, open `/a/cron-health` as
    an admin (5.5): every hourly job has a `lastRunAt` within the hour and status `ok`. The next
    morning all eight are `ok`, including `analytics-reconcile` after 03:50 UTC — and
    `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/monitor/crons`
    answers 200. Point the uptime monitor at it then, not before (11, Crons).

## 9. Release workflow

- `main` of the repository connected under Vercel → Settings → Git is production. Every push to
  `main` deploys the web app on Vercel; previews build from other branches with the preview env
  (5.3).
- There is no CI (`.github/` holds only a pull request template); the local gate is the only gate.
  Before every push to `main`: `npx tsc --noEmit -p .`, `npx eslint src realtime mcp tests`,
  `npm run tests:lib:vitest`, `npm run tests:credits:vitest`, `npm run tests:upload:vitest`,
  `npm run tests:agent:vitest`, `npx next build`, and
  `npx tsx --env-file=.env.local tests/mcp/e2e.ts` when the MCP or the API-key seam changed (it
  needs one open document slot on a Free workspace; 8 step 8).
- Before merging anything touching data shapes: add a migration under `db/migration/` and run it
  against production (4.1, snapshot first) before the deploy lands, since functions roll forward
  first. Mongoose `autoIndex` is on: any index declared in `src/lib/models/` is built by the first
  functions after the deploy, on live data, and a failure is silent. For a new index on a large
  collection (`shareviews`, `sharevisits`, `creditledgers`, `docpagetimings`, `activityevents`),
  or any new unique index, put the same index (same key, name and options) in a migration so it
  builds before traffic and a duplicate-key failure stops the runner where you can see it. Then run
  the index check (5.4).
- The realtime and MCP services do not auto-deploy. Run `fly deploy` (6.2 / 7) when a commit
  touches `realtime/`, `mcp/`, `src/lib/realtime/ticket.ts`, `src/lib/credits/schedule.ts`,
  `src/lib/credits/types.ts`, `tsconfig.json`, or the versions of `mongoose`, `ws`,
  `@modelcontextprotocol/sdk`, `express`, `zod` or `tsx` in `package.json` (mirror them in the
  Dockerfile). The MCP image copies the credit schedule, so a price change without an MCP deploy
  leaves `lnkdrp_whoami` quoting old costs. The services are backwards compatible with the web app
  across ordinary releases; deploy the web app first when both change. A services deploy restarts
  the single machine: every browser socket reconnects within a few seconds and every MCP session
  is dropped (clients get `404 Session not found` and must reconnect). Deploy MCP outside busy
  hours.
- Never point the analytics dev tools at production: `tests/share/traffic.ts` and
  `tests/share/seed-links.ts` write real share links and analytics rows to whatever
  `TRAFFIC_APP_URL`, `MCP_URL` and `MONGODB_URI` name, and `--spread` rewrites timestamps on rows they created.
  They are not part of any verification step here.
- Adding a cron job means a route with `runtime = "nodejs"` and `maxDuration`, a `vercel.json`
  entry, a `scripts/cron/cron.<job>.ts` runner and a `cron:<job>` npm script;
  `npm run tests:lib:vitest` fails when one is missing. Add it to the 5.1 table and crontab.

### 9.1 Share analytics: the gate before shipping a change to them

Run `npx tsx --env-file=<target>.env scripts/verify-share-analytics.ts` against the target
database before and after any release that touches the share analytics. `npm run verify:analytics`
always reads `.env.local`, so use it only for the local database. The check is read-only, safe
against production, and exits non-zero, so it also works as a CI step.

It asserts four properties, each of which failed silently in production shape at least once:

| Property | The bug it catches |
| --- | --- |
| Per-page time fits inside a row's total | The ingest counted an interval twice. Per-page time ran 26% over real dwell for weeks. |
| A link's counters equal the recomputation from its rows | A write path touched the link but wrote no row, so `/links` and the metrics page disagreed. |
| A document equals the sum of its links | The per-link table stopped adding up to the tiles above it. |
| Only signed-in rows carry the owner-preview flag | Something set the flag that cannot know the answer. |

Counter drift is repairable and the nightly `analytics-reconcile` job fixes it on its own; you can
force it with `CRON_SECRET='…' npx tsx scripts/cron/cron.analytics-reconcile.ts --target=https://lnkdrp.com`.
A **page-time overrun is not repairable and is never repaired automatically**: it means the ingest
double counted, and overwriting the rows would hide the bug instead of fixing it. The job reports
those in `CronHealth.lastResult` and marks itself `error` so the run is visible, which is the
signal to look at `src/lib/analytics/shareTiming.ts` and the flush logic in `PdfJsViewer`.

## 10. Rollback

- **Web app:** Vercel → Deployments → the last good production deployment → Instant Rollback.
  Code rolls back; data does not. Then:
  - Automatic promotion is off after a rollback. Pushes to `main` still build but do not go live
    until you Undo Rollback or promote a deployment by hand.
  - The rolled-back deployment runs with the env values it was built with. If you rotated
    `REALTIME_SECRET`, `CRON_SECRET` or a Stripe key since, redeploy with current env instead.
  - Check Settings → Cron Jobs still lists every job.
- **Database:** migrations and the 5.2 jobs are forward-only and some rewrite data, so the older
  build runs against migrated data; it is safe only against additive changes. If a release's data
  change is what broke, restore the snapshot taken before it (4.1 step 4; 11, Backups) and accept
  losing writes made since.
- **Services on Fly:** find the last good image, then deploy it without rebuilding:
  ```
  fly releases --image -a lnkdrp-mcp
  fly deploy --ha=false -a lnkdrp-mcp --config deploy/fly/mcp.fly.toml --image registry.fly.io/lnkdrp-mcp:deployment-<id>
  ```
  Same for `lnkdrp-realtime`. Do not roll back by rebuilding an old commit: the Dockerfiles install
  dependency ranges without a lockfile, so a rebuild produces a different image.
- **Services with Docker:** tag every build with the commit
  (`docker build -f mcp/Dockerfile -t lnkdrp-mcp:$(git rev-parse --short HEAD) .`), keep the last
  two tags, and roll back with `docker run` on the previous tag.
- **Stripe:** never delete prices; archive them. Price ids are read from env only when a Checkout
  starts. Changing `STRIPE_PRICE_ID` or `STRIPE_AI_CREDITS_PRICE_ID` and redeploying affects new
  subscriptions only; existing ones keep their old items until you change them in Stripe.

**Kill switches.** Any Vercel env change needs a redeploy to take effect.

| Stop | How | Takes effect |
|---|---|---|
| All Vercel crons (including Stripe usage reporting) | Vercel → Settings → Cron Jobs → Disable Cron Jobs; re-enable in the same place | Immediately |
| One cron | Remove its `vercel.json` entry and deploy (`tests/lib/cronMap.test.ts` then fails until the route, runner and npm script go too) | Next deploy |
| Hand runs and external schedulers | Rotate `CRON_SECRET` and redeploy. This does **not** stop Vercel Cron, which sends the new value | Next deploy |
| Realtime | Unset `NEXT_PUBLIC_REALTIME_URL` and redeploy the web app with a fresh build; browsers poll. The MCP server has its own copy (`deploy/fly/mcp.fly.toml`) and polls by itself when the socket fails | Next deploy |
| MCP | `fly scale count 0 -a lnkdrp-mcp`. `fly machine stop` is not enough: `auto_start_machines = true` starts it again on the next request. Keys stay valid for the REST API; revoke them at `/connect` | Immediately |
| AI spend | Remove `OPENAI_API_KEY` and redeploy; summaries and compares are skipped and not charged (4.5) | Next deploy |
| Outbound email | `EMAIL_TRANSPORT=console` and redeploy; mail is logged and dropped, except invites, which still send (4.6) | Next deploy |

## 11. Operating notes

- **Health:** `/api/health` (web), `/healthz` (both services), and `/api/monitor/crons` (below).
  Point an uptime monitor at all four. Realtime `/healthz` proves the process and sockets, not the
  change streams: a log line
  `activity stream error`, `apikeys stream error` or `docs stream error` can mean that stream has
  stopped for good while `/healthz` stays ok and browsers fall back to slow polling. Alert on those
  lines if your log drain supports it, and restart with `fly apps restart lnkdrp-realtime`; clients
  reconnect on their own. MCP `/healthz` `version` is fixed at `0.1.0`; use `fly releases -a lnkdrp-mcp`
  to see what is deployed.
- **Crons:** a 200 from a job does not mean the job worked, and Vercel Cron does not retry. Point
  an uptime monitor at `GET /api/monitor/crons` with `Authorization: Bearer $CRON_SECRET` — same secret and header as
  the schedules, because a monitor cannot hold the admin session `/a/cron-health` needs. It answers
  **200 while every job is healthy and 503 when any is not**, so an ordinary HTTP check alerts, and
  the body names the job and its state: `late` (no run for two whole intervals), `error`, `stuck`
  (left at `running`, so the function died mid-run, usually at the 300 s limit), or `never-run`.
  Add `?strict=0` to read the same body with a 200 by hand. Expect red until the first full round
  of jobs has run, which is deliberate: the alternative is a monitor that stays green for a cron
  that never fired. `src/lib/cron/jobs.ts` holds the schedules it judges against, and
  `tests/lib/cronMap.test.ts` fails if they drift from `vercel.json`.
  `credits-cycle-reconcile` counts failures in `errors` (and Free floor failures in `freeFloor`)
  and still answers 200, and `analytics-reconcile` answers 200 while marking itself `error`. Check
  `/a/cron-health` (admin, 5.5) daily after launch, then weekly: every job `ok`, with `lastRunAt`
  inside its schedule. Treat `error`, or a `lastRunAt` older than two intervals, on
  `stripe-credits-report`, `credits-cycle-reconcile` or `notification-emails` as an incident. A row
  left at `running` means the function died before writing a result, usually at the 300 s limit;
  run that job by hand with a smaller `--limit` (5.1) and read the function log. Leases expire on
  their own after 6 minutes; only a job answering `{ skipped: "locked" }` for longer needs
  `leaseUntil: null` set on its row in `cronhealths`.
- **Logs:** Vercel → Logs for the app; runtime logs are kept only briefly, so add a Log Drain
  (Settings → Log Drains) if you need history. `fly logs -a lnkdrp-realtime` and
  `fly logs -a lnkdrp-mcp` for the services (`docker logs` off Fly); they stream recent output
  only. With `ERROR_LOGGING_ENABLED=true`, server errors and cron failures are also stored in
  `errorevents` for 14 days, readable by an admin at `/api/admin/errors`. There is no page for them
  under `/a`.
- **Email failures:** Resend errors do not reach Vercel logs unless `DEBUG_LEVEL=1`. Start in the
  Resend dashboard Logs. Download requests store the error on the `sharedownloadrequests` row
  (`requesterEmailError`, `ownerEmailError`, `claimEmailError`). `notification-emails` counts
  `sendFailures` in `CronHealth.lastResult` and retries those recipients on the next run. A failed
  emailed invite returns 500, but the invite row already exists and its link shows in the team
  page's pending list.
- **Backups:** set up in 4.1 step 4. Restore: Atlas → Cluster → Backup → Restore to a new cluster,
  allowlist it as in 4.1, check it with `npx tsx --env-file=<restored>.env scripts/verify-share-analytics.ts`,
  then point `MONGODB_URI` at it on the web app and the realtime server and redeploy both. Do one
  test restore before launch. Vercel Blob has no backup: the app never deletes blobs, but a store
  removed by hand is gone.
- **Costs and quotas:** before launch, set a monthly budget and email alert on the OpenAI project
  that owns `OPENAI_API_KEY`, a Vercel Spend Management amount, and billing alerts on Atlas (backup
  storage adds to the cluster cost) and the Fly organization. Put Resend on a plan above the free
  tier (100 emails a day); over quota, sends fail. Blob storage only grows: the app never deletes a
  blob, including old versions and deleted documents.
- **Scaling:** the web app scales with Vercel. MCP must stay at one machine (sessions are in
  memory) unless you add sticky routing on `Mcp-Session-Id`. Realtime can run more than one
  machine: each runs its own change streams and serves its own sockets, and each extra machine
  adds three change streams on Atlas.
- **Secrets rotation:** `REALTIME_SECRET` must change on all three pieces in one go; tickets are
  60 seconds, so a brief mismatch only costs reconnects. `NEXTAUTH_SECRET` rotation signs everyone
  out and voids summary reruns started in the last 5 minutes; if `REALTIME_SECRET` or the two
  secrets in 3 are unset, they fall back to it, so rotating it also breaks what those protect.
  Changing `LNKDRP_SHARE_PASSWORD_SECRET` (or adding it later) makes every recipient re-enter link
  passwords, and owners see existing link passwords as empty until they set them again; password
  checks keep working. Changing `LNKDRP_ORG_INVITE_TOKEN_SECRET` hides the links of pending invites
  in the workspace invite list; links already sent still work. `CRON_SECRET` rotation: update any
  external runner too. Every rotation needs a redeploy.
- **Security headers:** `next.config.ts` sends `Content-Security-Policy: frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin` on every response Next serves. Check after a
  deploy with `curl -sI https://lnkdrp.com/s/<shareId>`. Framing is SAMEORIGIN rather than DENY on
  purpose: the app frames its own pages (`/paperplane/index.html`, `/api/docs/:id/pdf`). Vercel
  adds HSTS on its own. The API sends no CORS headers on purpose: API keys are for servers and
  agents.
- **Rate limits:** all fixed-window counters in `ratelimits`, shared across functions, and all
  fail open if Mongo is unreachable. Link unlock and download requests are per IP; share stats are
  120/minute per IP; temp-workspace creation is `TEMP_WORKSPACE_CREATE_LIMIT` (20) per IP per hour,
  charged only when a workspace is actually minted, so a visitor reusing its temp-user headers
  never pays again; API keys are `API_KEY_REQUEST_LIMIT` (300) per key per minute, per key rather
  than per IP because every agent's REST call leaves the MCP server from one address. A refused
  caller gets 429 with `Retry-After` and an `error` code it can branch on
  (`temp_workspace_rate_limited`, `api_key_rate_limited`). Both ceilings are env-overridable;
  before lowering the key limit, note that a normal agent session bursts about seven tool calls in
  200ms, so anything under roughly 30/minute breaks ordinary use. To clear a bucket by hand:
  `db.ratelimits.deleteOne({ key: "api-key:<keyId>" })`.
- **What is intentionally off at launch:** Requests, AI review and Deep Search are hidden
  (`NEXT_PUBLIC_FEATURE_REQUESTS` unset). Paid seats are not sold; Pro includes one collaborator.

## 12. Known gaps before first production traffic

- Stripe live catalog and webhook do not exist yet; only the sandbox is configured.
- Neither service is deployed yet. Fly.io is the chosen host (section 6.1), configs are in
  `deploy/fly/`; DNS for `mcp.lnkdrp.com` and `realtime.lnkdrp.com` still has to be created.
- Resend sending domain (4.6) and the Google consent screen publishing status (4.3) are not done.
- Check the sandbox Stripe Pro product description against 4.2 (older text said summaries never use credits).
- **If you ever add a real Content-Security-Policy**, know what it breaks first. The app sends only
  `frame-ancestors 'self'` today (11, Security headers). `public/paperplane/index.html` loads
  `three` from `https://esm.sh` at runtime, so a `script-src` that omits that host kills the
  marketing page's animation — and the page still renders, so the symptom is a blank space, not an
  error anyone will see. Vendor `three` locally first, or allow the host explicitly.
- **Decision pending:** view counts can be inflated by anyone who posts made-up visitor ids to
  `/api/share/:shareId/stats` (only a 120 requests per minute per IP limit applies). Decide on an
  abuse budget or tighter rate limits before relying on view counts for billing or reports.
- **Still to do in infrastructure:** the app now caps temp-workspace creation and API-key traffic
  itself (11, Rate limits), but every refused request has still woken a function and read Mongo.
  Add a Vercel Firewall rate-limit rule on `/api/*` per IP so abuse is refused before it costs
  anything. Exclude `/api/cron/*`, `/api/stripe/webhook`, `/api/blob/upload` and the MCP server's
  outbound IP (allocate one with `fly ips allocate-egress -a lnkdrp-mcp -r iad`), because every
  agent's REST call leaves from that one address. Nothing collects temp workspaces once created:
  watch the count of `users` with `isTemp: true` and write a reaper if it grows.
- Free workspaces cannot buy extra credits; sign-up copy promises only the monthly top-up to 10
  and Pro for more. Selling credit packs to Free would need a Checkout product and webhook grant.
- If production starts from an existing database, run the one-time data jobs in 5.2.
