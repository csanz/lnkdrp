# Deploying lnkdrp

This is the runbook for taking lnkdrp from `main` to production and keeping it there. It covers
the three deployable pieces, the managed services they depend on, the exact environment each
one needs, the order to bring them up, how to verify a release, and how to roll one back.

The older first-deployment checklist lives in `docs/deploy/Deploy_1.md`. It is superseded; this
file is the source of truth. Its secret names are now current (`CRON_SECRET`, `REALTIME_SECRET`), but
its `MONGODB_DB_NAME` and `BLOB_BASE_URL` rows and its lease note (two jobs; four take one) are still
stale (5 step 3, 5.1).

## 0. Launch sequence

The whole runbook as one ordered list. Each line names the section that has the detail; do them
in this order, because almost every step needs the one before it. Section 12 is read and signed
off before announcing (G); section 11 is for after launch.

**Lead time — start days before A**

- [ ] Stripe: activate the account for live payments (business details, bank account, identity
      checks). Live mode has never been configured, and live keys cannot take real charges until
      Stripe finishes this (4.2).
- [ ] Resend: add `lnkdrp.com` and create its DNS records now; verification waits on DNS (4.6).
- [ ] Admin account: a Google Workspace account on a domain you control, with 2-Step Verification
      enforced (5.5 step 6). If that domain has no Google Workspace yet, sign up and verify it now.
- [ ] DNS: lower the TTLs on `lnkdrp.com` and `www`, and decide when the apex moves to Vercel (D).
- [ ] Google: basic scopes need no review to publish the consent screen. Brand verification
      (showing the app name and logo) needs `lnkdrp.com` verified in Google Search Console and
      `/privacy` and `/tos` answering 200, so submit it only after D if you want it (4.3).

**A. Before anything — one sitting**

- [ ] Accounts and access in hand: Atlas, Vercel **Pro**, Stripe live (activated), Google Cloud,
      Blob, OpenAI, Resend, DNS for the three hosts, `flyctl` logged in (2).
- [ ] Generate the five secrets once, plus `CRON_MONITOR_SECRET`, and store them (3).
      `REALTIME_SECRET` goes to three places; `NEXTAUTH_SECRET` only to Vercel.
- [ ] `package.json` `engines` → `"22.x"` so Vercel matches the `node:22` service images (2).
- [ ] Local gate on the exact commit you will release: `npx tsc --noEmit -p .`, `npx eslint src
      realtime mcp tests`, the three vitest suites (lib, credits, upload), `npx next build` (9).
- [ ] Commit the engines change and merge the release branch into `main` through a pull request
      (`main` is protected, 9; `main` on `origin` is Vercel's production branch). Note the SHA. Run
      the migrations (4.1 step 5), the 5.2 jobs and both `fly deploy`s from a clean checkout of that
      SHA, after `npm ci` in it: an older checkout has no files for newer migrations, so the runner
      silently never runs them, and a fresh clone has no `node_modules` (`run.mjs` fails with
      `ERR_MODULE_NOT_FOUND` for `dotenv`, and every `npx tsx` job needs `tsx`). 8 step 1 checks
      that `/api/health` `version` matches it.

**B. Managed services (4)**

- [ ] Atlas: **M10 or larger** cluster (M0 and Flex have no point-in-time restore) in
      **us-east-1**; a read/write user for the web app and a read-only user for realtime; network
      access decided (4.1 step 2: `0.0.0.0/0` with strong passwords, or a strict allowlist that also
      lists your own IP before the migrations run); URI **with `/lnkdrp` in the path**; Cloud
      Backup + point-in-time ON. **Existing database only:** wait for the first snapshot, then Take
      Snapshot Now and note the time. Then run the migrations (4.1).
- [ ] Existing database only: the one-time data jobs in 5.2 (steps 2–9), in order, from the
      release commit, before the first production deploy. None of them needs the web app. If an
      older build still serves that database, run steps 4–5 again after the deploy (they are
      idempotent), then step 9. A fresh database needs nothing beyond the migrations.
- [ ] Stripe live: Pro $29 price · `ai_credits` meter · $0.10 metered price · webhook with the seven
      events, API version `2025-12-15.clover`, and its signing secret · portal saved · revenue
      recovery on · Customer emails → Successful payments ON (credit-pack receipts) · Pro
      description from 4.2 step 1 (fix the sandbox product's description too, 12). Then verify
      both price ids with the live key (4.2 step 9) — nothing in the code checks them. Credit packs
      (30/$5, 60/$9, 300/$39) need **no** catalog entry: their only live requirement is
      `checkout.session.async_payment_succeeded` among those seven events (4.2, Credit packs).
- [ ] Google OAuth: client with the exact callback URI; consent screen External and **In
      production**, or only test users can sign in (4.3).
- [ ] Blob: **public** store in `iad1`, connected to Production only (4.4).
- [ ] OpenAI project key that allows `gpt-4o-mini` on the Responses API (4.5).
- [ ] Resend: `lnkdrp.com` shows **Verified** (SPF, DKIM), API key, From addresses (4.6).
- [ ] DMARC: `_dmarc.lnkdrp.com` resolves. Resend never creates this one — see 4.6 (4.6).

**C. Realtime on Fly (6)**

The realtime server reads only `MONGODB_URI`, `REALTIME_PORT` and its ticket secret; it does not
need the web app, so it goes up first and the first web build already carries its URL.

- [ ] Realtime: `fly launch`, egress IP **only if Atlas uses an allowlist** (add it before the first
      deploy), secrets, `fly deploy --ha=false`, `/healthz` on the `fly.dev` host with all seven
      `streams` true, cert, DNS-only
      CNAME, `fly certs check`, `/healthz` on `realtime.lnkdrp.com` (6.2).

**D. Web app on Vercel (5)**

From this deploy on, `lnkdrp.com` is public once DNS points at it. Do D → E → F without a break
and do not link to or announce the site until the Announce step in G.

- [ ] Import the repo, Node 22, domains `lnkdrp.com` and `www` → redirect (5, steps 1–2). The
      import screen's Deploy button builds a production deployment at once, with whatever env the
      screen holds. Either enter the step 3 table there, or treat that first build as throwaway:
      it has empty `NEXT_PUBLIC_*` values baked in, and step 6 below is a fresh redeploy.
- [ ] DNS: set the apex and `www` records Vercel → Domains shows. Wait until both show Valid
      Configuration with a certificate, and `curl -sI https://lnkdrp.com` answers with
      `server: Vercel`, before deploying or running any step in 8.
- [ ] Production env: every required row of the table in 5 step 3, entered by hand (never import
      `.env.local`). Set `NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com` now that C is live;
      if realtime is not ready, leave it unset and the app polls (then set it and redeploy with a
      fresh build later).
- [ ] Never set `API_TEST_BYPASS_AUTH`, `API_TEST_USER_ID`, `ADMIN_LOCALHOST_BYPASS`, `DEBUG_*`;
      delete the legacy aliases (5, after the table).
- [ ] Deployment Protection: keep the default **Standard Protection**, which already leaves
      `lnkdrp.com` public, as the summary reruns need. Do not disable protection (5 step 5).
- [ ] Deploy (5 step 6): Redeploy with the build cache off, so every `NEXT_PUBLIC_*` value from
      the table is in the bundle.
- [ ] **Cron jobs.** Nothing to configure by hand: `vercel.json` registers all ten on deploy, and
      Vercel sends `CRON_SECRET` from the env as the bearer. Confirm Vercel → Settings → Cron Jobs
      lists exactly these ten (5.1 has flags and leases):

      | Job | UTC schedule | What it does |
      |---|---|---|
      | `notification-emails` | every 5 min | view emails (on by default), doc-update emails and daily digests, download-request mail |
      | `credits-cycle-reconcile` | hourly :10 | Pro credit cycle grants (backstop; the webhook is primary). Checks up to 200 Pro subscriptions per run, stalest stored period end first, so a missed renewal is reached even with more than 200 |
      | `usage-agg-reconcile` | hourly :20 | rebuilds usage aggregates from the credit ledger |
      | `stripe-credits-report` | hourly :30 | sends on-demand credit usage to the Stripe meter — **this is billing** |
      | `plan-limits` | hourly :40 | Free grace period: start, day-7/day-12 reminders, block, clear |
      | `doc-metrics` | every 6 h | per-document metric snapshots |
      | `stripe-credits-reconcile` | every 6 h :15 | syncs Stripe periods onto subscriptions, backstops cycle grants |
      | `analytics-reconcile` | daily 03:50 | repairs link counter drift; reports page-time overruns as `error` |
      | `credits-purchase-expiry` | daily 04:05 | takes back unspent credit-pack credits 12 months after purchase |
      | `account-purge` | daily 04:30 | deletes the data of accounts 30 days after they asked — **this deletes blobs** |

      Vercel **Pro is mandatory** — eight of the eleven run more than once a day and Hobby rejects
      the file. Not on Vercel Cron? Schedule the same ten with the crontab in 5.1 from one
      always-on host; never two schedulers. The realtime and MCP services have no scheduled work.
- [ ] Preview environment scoped on its own: sandbox Stripe, its own database and Blob store,
      different secrets (5.3).

**E. MCP on Fly (7)**

- [ ] MCP: `fly launch`, `REALTIME_SECRET`, `fly deploy --ha=false`, **exactly one machine**,
      `/healthz` on the `fly.dev` host, the startup log shows the realtime URL, cert, DNS-only
      CNAME, `fly certs check`, `/healthz` on `mcp.lnkdrp.com` (7).
- [ ] `LNKDRP_ALLOW_LOCAL_FILES` stays **unset** on `lnkdrp-mcp`, in `[env]` and in `fly secrets`.
      With it set, an agent's `filePath` becomes a read of the container's filesystem (7).
- [ ] Nothing to decide about Ghostscript: `mcp/Dockerfile` installs it and `pdfjs-dist`, so inline
      uploads are shrunk before sending and the page count is verified on both files (7).
- [ ] Remember the services do not auto-deploy: `fly deploy` again whenever a file listed in 9
      changes.

**F. Verify (8)**

- [ ] Release checks 1–2 in 8.
- [ ] Make one admin (5.5) on a **second, dedicated** Google account, not the one checks 3–13 use
      to create keys and connect the MCP. Sign in once with it, run the mongosh update, sign out and
      back in. Then refresh the Pro price label (5.5 step 5): `/pricing` must show $29.
- [ ] Release checks 3–14 in 8, in order. The ones that fail silently without them: security
      headers (1), published consent screen (2), pdf.js fonts (3), index check (4, again after 10
      and 14), Stripe subscription showing two items (10), every cron fired by the scheduler, not
      by your hand runs (14).

**G. Before you announce (11, 12)**

- [ ] Budgets and alerts: OpenAI, Vercel Spend Management, Atlas (including connections), Fly;
      Resend on a paid plan — the free tier is 100 emails a day, and view emails are on by default
      for every workspace member, so once links are opened after the deploy one day's 23:00 UTC
      digests alone can pass it (4.6, 11 Costs).
- [ ] One test restore of an Atlas snapshot, and read the restore procedure in 10 (11, Backups).
- [ ] MCP egress IP, which the Firewall rule for MCP traffic in 12 targets:
      `fly ips allocate-egress -a lnkdrp-mcp -r iad`, then `fly apps restart lnkdrp-mcp` so the
      machine sends from it, and note the IPv4 from `fly ips list -a lnkdrp-mcp`. Without it, Fly's
      shared outbound addresses cannot be targeted and the per-IP `/api/*` rule counts every agent
      as one caller.
- [ ] Vercel Firewall rules from 12; the in-app ceilings are a floor, not the answer.
- [ ] Uptime monitor with a named alert recipient on `/api/health` and both `/healthz`; Vercel Log
      Drain with alerts; Stripe webhook failure emails to a watched inbox (11, Health and Logs).
- [ ] Read 12 and decide each open item, or accept it in writing.
- [ ] **You are the door.** Every new account is queued — there is no flag, and there is no
      environment in which sign-up lets someone straight in (5 step 3). They sign in, land on the
      queue page and can do nothing until an admin approves them at `/a/waitlist`, which sends
      `waitlist_approved`. Two things to do before announcing: make sure at least one account is an
      admin (`npm run admin:add -- --to=you@example.com`), or there is nobody who can approve
      anyone; and put your own addresses in `WAITLIST_ALLOW_EMAILS` so you are never queued behind
      your own launch. Then watch `/a/waitlist` from the announcement.
- [ ] **Announce / open to users.**

**H. Watch (11) — first week**

- [ ] After the first full round of jobs, add `/api/monitor/crons` to the uptime monitor with
      `Authorization: Bearer $CRON_MONITOR_SECRET` (200 healthy / 503 not), never with `?secret=`,
      which production refuses with 401 (11, Crons).
- [ ] Daily: `/a/cron-health`, reading each job's `lastResult`, not just the pill (11, Crons).

## 1. Topology

```
                     ┌──────────────────────────────────────────────┐
  browser / agent ─▶ │  lnkdrp.com  · Next.js on Vercel             │ ─▶ MongoDB Atlas (replica set)
                     │  web app + REST API + 10 cron routes         │ ─▶ Vercel Blob (PDF storage), Resend (email)
                     └───────────────┬──────────────────────────────┘ ─▶ OpenAI (summary, AI compare)
                                     │ REST with the caller's lnk_ key  ─▶ Stripe (Pro + on-demand credits)
                                     │                                  ─▶ Google OAuth (sign-in)
  MCP client ──────▶ mcp.lnkdrp.com  · Node service (mcp/)  ───────────┘
                     thin translator; no database access; holds the realtime ticket secret

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

Two families of URL are public and unauthenticated: `/s/:shareId`, one document, and `/p/:shareId`,
a project link — several documents behind one link, each opened at `/p/:shareId/:docId`, with its
own analytics and its own password, expiry and download settings. Agents create both (`lnkdrp_*`
project and project-link tools, 7). Each streams its PDF through a function, at `/s/:shareId/pdf`
and `/p/:shareId/:docId/pdf`, so both belong in the firewall rules in 12.

## 2. Prerequisites

- **MongoDB Atlas** cluster, M10 or larger for change streams under load and for backups (M0
  works for a smoke test). It must be a replica set; Atlas always is.
- **Vercel** project on the **Pro** plan connected to this repository, Node 22 runtime, Fluid
  compute on (the default). Hobby rejects this `vercel.json`: its crons run at most once a day.
  `package.json` `engines` overrides the project setting, and the current `">=22"` deploys the
  latest 24.x; change it to `"22.x"` to match the services images (`node:22.23.2-alpine`).
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
openssl rand -hex 32      # CRON_MONITOR_SECRET (read-only; for the uptime monitor, 11 Crons)
```

`node scripts/gen-env-secrets.mjs` prints the same five (not `CRON_MONITOR_SECRET`) as
`NAME="value"` lines and works as well. It writes to your terminal scrollback, so clear it after
copying, and drop the quotes before putting a line in a `fly secrets import` file.

`NEXTAUTH_SECRET` lives only on Vercel. Never set it on the realtime or MCP hosts, even though both
accept it in place of `REALTIME_SECRET`: whoever holds it can
forge a session for any user, admins included, and sign the internal processing token.
`REALTIME_SECRET` must be set on Vercel too and must differ from `NEXTAUTH_SECRET`; if it is unset
there, the app signs tickets with `NEXTAUTH_SECRET` and the services would need that value.

Never type a secret inline on a command line; it lands in shell history. For Fly, write
`NAME=value` lines to a file, run `fly secrets import -a <app> < file`, then delete the file. For
Docker, use `docker run --env-file <file>`: it keeps values out of shell history and `ps`, but
anyone with Docker access on the host still reads them with `docker inspect`, so restrict Docker
access there. For one-off commands, `read -rs CRON_SECRET && export CRON_SECRET` (the same for
`MONGODB_URI`); the commands below assume the variable is exported that way, or use `prod.env` (5.2).

This runbook names three secret files in the repository root: `prod.env`, `realtime.env` and
`mcp.env`. `.gitignore` and `.dockerignore` list all three (and `.env.*`), so `git status` stays
clean, the files cannot be committed by accident, and `fly deploy` does not upload them to Fly's
remote builder. That is the only protection: use exactly those names (or a `.env.*` name), and
still delete each file as soon as the command that needs it has run, including when that command
fails.

Set `LNKDRP_SHARE_PASSWORD_SECRET` and `LNKDRP_ORG_INVITE_TOKEN_SECRET` before first traffic and change them only after a leak. They fall back to
`NEXTAUTH_SECRET`, but they are encryption keys for stored data: link passwords and pending
invite tokens are saved encrypted with them, so an owner can read a link's password back and a
workspace owner can copy a pending invite URL. Adding one later works like a rotation (11,
Secrets rotation).

`LNKDRP_NOTIFICATION_TOKEN_SECRET` is optional (`openssl rand -hex 32` if you set it). It signs the
one-click **Turn off these emails** link in view emails (a 30-day HMAC token, no stored data) and
falls back to `NEXTAUTH_SECRET` when unset. In production one of the two must be set or view
emails cannot be built, and that failure is silent: the off page returns a 500, and the cron's
view block throws for every workspace with something to send, which shows only as
`views.errors` in the `notification-emails` result and in the logs. Setting it keeps the off links working through a `NEXTAUTH_SECRET`
rotation; changing it (or adding it later) makes the off links in already-delivered emails show
"This link is not valid" until the next email arrives with a new one.

## 4. Managed services, in order

### 4.1 MongoDB Atlas

1. Create a dedicated **M10 or larger** cluster (M0 and Flex have no point-in-time restore) on
   **AWS us-east-1 (N. Virginia)** and a database user with read/write on `lnkdrp` for the web app
   and the migration machine. Create a second user, `lnkdrp-realtime`, with the built-in `read`
   role on `lnkdrp` only (it includes `changeStream` and `find`, all realtime does); its URI goes to
   the realtime server in 6.2 and 6.3, so a leaked Fly secret cannot write production data. Use the
   built-in role, not a hand-rolled one scoped to named collections: the server watches seven —
   `activityevents`, `apikeys`, `docs`, `projects`, `uploads`, `shareviews` and `projectlinkviews` —
   and it grows with the product. A custom role that misses one takes `/healthz` to 503 and exits
   the machine in a restart loop (11, Health), which reads as an outage, not a permission. The two
   URIs rotate separately (11, Secrets rotation). Vercel functions run in `iad1` and both Fly apps in
   `iad`; a cluster anywhere else adds latency to every request. `vercel.json` does not pin
   `regions` yet (12), so the function region rests on Settings → Functions → Function Region:
   check it reads `iad1` and leave it there.
2. Network access is a decision; Vercel functions have no fixed outbound IPs (only a paid Static
   IPs add-on or Secure Compute gives them).
   - (a) `0.0.0.0/0`, with long generated passwords on users limited to `lnkdrp`. This is what
     Vercel recommends. Skip `fly ips allocate-egress` for realtime (6.2): it adds nothing.
   - (b) A strict allowlist: Vercel's static IPs (paid), the realtime egress IP (allocate it first,
     6.2), and your operator IP as a temporary entry with an expiry (Atlas → Network Access → Add
     IP). Every direct-database command in this runbook runs from that machine: 4.1 step 5, 5.2,
     5.4, 5.5, 8 steps 8 and 12, 10 (Database) step 4, and the daily billing query in 11 (Crons).
     Add it before the migrations or the runner times out, and set the expiry past the first week
     after launch (0 H), or re-add it each time it lapses.

   The MCP server never talks to Atlas.
3. Copy the URI with the database name in the path:
   `mongodb+srv://user:pass@cluster.x.mongodb.net/lnkdrp?retryWrites=true&w=majority`. Atlas's
   Connect string has no database path; add `/lnkdrp`. This is `MONGODB_URI` for the web app and
   (with the read-only user) the realtime server. The MCP server takes none.
4. Backups: turn on Cloud Backup and Continuous Cloud Backup (point-in-time restore) before any
   real customer data exists. M0 and Flex have no continuous backup, and a newly enabled cluster
   has no restorable point until its first snapshot finishes. Before every migration run or
   one-time data job against a database with real data, take an on-demand snapshot (Atlas → Backup
   → Take Snapshot Now) and write its time down. Migrations and data jobs have no down step;
   restoring to that point is the only undo (10, Database; 11, Backups).
5. Run migrations from a trusted machine, from a clean checkout of the release commit (0 A): an
   older checkout has no files for newer migrations, so the runner silently never runs them. Run
   `npm ci` in that checkout first (the runner imports `dotenv` and `mongoose`). Put
   the URI in `prod.env` (5.2) with `MONGODB_DB_NAME=lnkdrp` alongside it, and export
   `MONGODB_URI` in the shell for `mongosh` (3):
   ```
   node --env-file=prod.env db/migration/run.mjs --dry-run
   mongosh "$MONGODB_URI" --quiet --eval 'db.getName() + " " + db.docs.estimatedDocumentCount()'
   node --env-file=prod.env db/migration/run.mjs
   ```
   `run.mjs` (and the two `.mjs` backfills in 5.2) also load `.env.local` from the repo root, where
   they must run, and fill in any variable you did not set, including `MONGODB_DB_NAME`, which is
   passed as `dbName` and overrides the `/lnkdrp` path of the URI. Setting it in `prod.env` (or
   moving `.env.local` aside) closes that. `--dry-run` only lists migration files; it does not
   connect, and the real run never prints the host or database it connected to, so confirm the
   target with the `mongosh` line first (database `lnkdrp`, a production-sized count; a fresh
   database reads 0). On a database that already has data, `run:` for every file means the wrong
   database. The real run prints `skip (already applied)` or `run:` for each file, so read that
   output. Migrations create and
   drop indexes and also rewrite data (orgId backfills, personal-org dedupe, `$unset` of null
   `slug`, `personalForUserId` and `claimTokenHash`). Two of them replace a unique+sparse index
   with a partial one (`20260911_0001` for `orgs.slug`, `20260915_0001` for
   `orgs.personalForUserId`); without the second, the *second* team workspace in the database
   fails with E11000, reported to the user as "An org with that slug already exists".
   `20260916_0001` creates the billing unique indexes and the `sharelinks` text index (5.4) before
   traffic; on an existing database a duplicate `eventId`, Checkout session, ledger key, balance or
   subscription row stops it with E11000, which is the point: fix the rows, then re-run.
   `20260916_0002` adds two non-unique `shareviews` indexes, `docId_1_lastViewedAt_-1` and
   `shareId_1_lastViewedAt_-1`, that back the activity window on the metrics pages (`/metrics` for
   the workspace, `/doc/:id/metrics` and `/project/:slug/metrics` for one of each); it cannot fail
   on data. The
   same release adds nullable `sharevisits` fields (`pageCount`, `timingVersion`,
   `pageEvents[].reason`, `pageEvents[].toPage`); older rows keep null and read as legacy, so there
   is no backfill. Applied ones are recorded in the `migrations` collection and
   skipped on re-run. A failing migration (for example E11000 while building a unique index)
   stops the runner at that file; a re-run resumes there once the data is fixed.

### 4.2 Stripe (live mode)

The account must be activated for live payments first (business details, bank account, identity
checks); start that days ahead (0, Lead time). Mirror the sandbox catalog, which is already
correct. Ids for the sandbox are in `docs/SUBSCRIPTION.md`; the live ones will differ. The catalog is steps 1–3 and nothing else: the
credit packs on `/credits` have no products or prices in Stripe on purpose (see Credit packs after
step 9), so don't go looking for them.

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
   meter, unit label `credit`. Metadata `type=ai_credits`. It is attached to every Pro
   subscription at checkout (on-demand overage, off by default; a Pro owner turns it on from
   Limits). On-demand is Pro-only since 2026-09-17: Free workspaces buy credit packs, and
   `POST /api/stripe/checkout { plan: "payg" }` refuses with 400 `PAYG_RETIRED`. The app reports
   one meter unit per on-demand credit. Turning on-demand off does not cancel usage already
   recorded: those ledger rows are still reported by `stripe-credits-report` and invoiced.
4. Webhook endpoint `https://www.lnkdrp.com/api/stripe/webhook` — **the `www`, not the apex**:
   `lnkdrp.com` 308-redirects to `www` and webhook POSTs do not reliably follow redirects. With
   these events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`, `checkout.session.async_payment_succeeded`, events from Your account
   only, API version `2025-12-15.clover` (the one stripe@20 pins and `src/lib/billing/stripePeriods.ts`
   reads; match the sandbox endpoint). Copy the signing secret to `STRIPE_WEBHOOK_SECRET`. The last one only matters for credit packs paid with a delayed
   method (a bank debit): without it such a payment succeeds in Stripe and the credits never
   arrive. Card payments are granted from `checkout.session.completed`.
5. Customer portal (live mode): enable cancel, payment-method update and invoice history. Turn
   **off** subscription updates (switch plans, change quantity): the app sells one Pro seat at
   quantity 1 and ignores quantity, so a change only raises the bill. Click Save once; until the
   live configuration is saved, `/api/stripe/portal` returns 400 and Manage subscription fails.
   The app sets the return URL on every session (`NEXT_PUBLIC_APP_URL` + `/dashboard?tab=overview`).
   The same portal serves a Free workspace's pay-as-you-go subscription too — it is looked up by
   `stripeCustomerId` alone, with no branch on what the subscription is for.
6. Revenue recovery (Billing settings, live mode): turn on Smart Retries and the failed-payment
   email, and cancel the subscription after the last retry. `active`/`trialing` means *billable*,
   not Pro — a Free workspace's pay-as-you-go subscription is active too, and the same failure
   path applies to it: a failed renewal moves the subscription to `past_due`, which turns
   on-demand off at once (`src/lib/billing/subscriptionState.ts` is what tells the two apart). For
   a Pro subscription this also drops the workspace to Free limits; it returns to Pro on
   the next successful payment (`invoice.paid`). For pay-as-you-go there are no limits to drop —
   the workspace was already Free — only the card to fix and on-demand to turn back on.
7. Env: `STRIPE_SECRET_KEY` (sk_live), `STRIPE_PRICE_ID` (the $29 price),
   `STRIPE_AI_CREDITS_PRICE_ID` (the $0.10 price). `STRIPE_CREDITS_METER_EVENT_NAME` defaults to
   `ai_credits`; set it only if the live meter uses another event name.
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is optional; no current page reads it.
8. Set `STRIPE_AI_CREDITS_PRICE_ID` before the first live Checkout. Nothing checks it at startup.
   Without it Checkout still sells Pro, but with no metered item; workspaces can still turn
   on-demand on and spend credits, and `stripe-credits-report` never sends that usage to Stripe.
   Setting the variable later does not fix existing subscriptions: add the $0.10 price to each
   one in Stripe; the `customer.subscription.updated` event that follows links it. Resending an
   old event does nothing, the webhook skips events it already processed. Pay-as-you-go has no
   fallback the way Pro does: without this price there is nothing to sell, and
   `POST /api/stripe/checkout { plan: "payg" }` refuses with 400 rather than silently doing
   nothing. No button in the app starts that checkout any more (credit packs replaced it; 12).
9. Before the first production deploy, check both ids with the live key:
   ```
   curl -s https://api.stripe.com/v1/prices/$STRIPE_PRICE_ID -u "$STRIPE_SECRET_KEY:"
   curl -s https://api.stripe.com/v1/prices/$STRIPE_AI_CREDITS_PRICE_ID -u "$STRIPE_SECRET_KEY:"
   ```
   Both must return a price with `"livemode": true`; a sandbox id returns `No such price`. The
   credits price must show `recurring.usage_type` `metered` and `recurring.meter` equal to the id
   of the meter whose `event_name` is `ai_credits`; list the meters with
   `curl -s https://api.stripe.com/v1/billing/meters -u "$STRIPE_SECRET_KEY:"`. The code checks
   neither: a sandbox id fails only when a customer clicks Upgrade, and a price on another meter
   accepts usage that never reaches an invoice.

**Credit packs** (`/credits`: 30 credits $5, 60 $9, 300 $39) need nothing in the Stripe catalog and
no env var; their one live-mode requirement is the `checkout.session.async_payment_succeeded`
webhook event (step 4). Checkout is created with inline `price_data` from `src/lib/credits/packs.ts`, so the
same code sells them in sandbox and live; changing a price is a code change and a deploy. The
webhook grants the credits once per Checkout session (`creditpurchases`, unique on the session
id) after checking the paid subtotal against the price recorded on that Checkout. Purchased
credits are spent after starter and included credits, lift the Free daily cap for that workspace,
and expire 12 months after purchase (`credits-purchase-expiry`, 5.1). Stripe's receipt email is the
buyer's record: turn on "Successful payments" under Settings → Customer emails in live mode.

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
With only these basic scopes, publishing needs no Google review. Brand verification (showing the
app name and logo) is separate: it needs `lnkdrp.com` verified in Google Search Console and the
privacy and terms pages answering 200, so submit it only after the web app is live (0 D).

### 4.4 Vercel Blob

Create a store with **public** access in Washington, D.C. (`iad1`), next to the functions and
Atlas (4.1); a store's region is fixed at creation, and processing reads and writes PDFs of up to
250 MB through it inside the 300 s budget (5 step 4). Every write uses `access: "public"`, and
production accepts only URLs on `<storeId>.public.blob.vercel-storage.com`, derived from
`BLOB_READ_WRITE_TOKEN` unless `BLOB_BASE_URL` is set, which takes precedence (leave it unset; 5
step 3).
Connect the store to Production only and give Preview its own store; with one store on every
environment, preview uploads land beside production files and each environment accepts the
other's URLs. Copy `BLOB_READ_WRITE_TOKEN`.

**Publish the email logo into this store before the first send.** Every transactional email loads
its logo from an absolute URL, and the default baked into `src/lib/email/layout.ts` points at the
store this was developed against — so without this step production mail renders its logo out of a
developer's personal Blob store, and keeps doing so until that store is deleted, rotated or made
private, at which point every notification, invite, plan-limit and waitlist email shows a broken
image with nothing failing and nothing logged. Run `scripts/publish-email-logo.ts` with the
production `BLOB_READ_WRITE_TOKEN` and set `EMAIL_LOGO_URL` to the URL it prints
(`https://<storeId>.public.blob.vercel-storage.com/brand/email-logo.png`).

Uploads go browser → Blob with a token minted by `/api/blob/upload`: PDF up to 250 MB and the page
preview PNG under `docs/`, PNG/JPEG/WebP under `org-avatars/`. The browser tells the app when an
upload is done; the app registers no Blob completion callback, so `VERCEL_BLOB_CALLBACK_URL` is
not used.

A PDF reaches the app three ways, with two different ceilings.
`src/lib/limits/uploads.ts` is the single source for both; nothing else defines one:

| Path | Ceiling | Where the bytes travel |
|---|---|---|
| Browser direct-to-Blob (`/api/blob/upload` token, the Upload button) | `BROWSER_DIRECT_UPLOAD_MAX_BYTES`, **250 MB** | browser → Blob; never through a function body |
| URL import (`POST /api/uploads/:id/import-url`, the MCP's `sourceUrl`) | `UPLOAD_MAX_BYTES`, **50 MB** | the function fetches the URL and streams it to Blob |
| Inline base64 (`POST /api/uploads/:id/import-bytes`, the MCP's `fileBase64` and `filePath`) | `UPLOAD_MAX_BYTES`, **50 MB** | the bytes are a JSON request body on a serverless function |

**The inline path cannot carry 50 MB on Vercel.** Vercel Functions cap a request body at about
4.5 MB whatever its content type, and base64 costs ~4/3 of the decoded size before the JSON
envelope is counted, so anything past roughly 3 MB decoded fails with the platform's own 413 —
usually before the request reaches the route, so no app error message and no `errorevents` row
explains it. That is the platform's limit, not a setting: nothing in `vercel.json` or the env
raises it. It is why the MCP shrinks a PDF before sending (7, Ghostscript). The other two paths do
carry their stated limits in production. Read "max 50MB" in error copy and MCP tool descriptions as
optimistic for the inline path, and prefer `sourceUrl` or the Upload button for anything larger
than a few megabytes (12).

### 4.5 OpenAI

`OPENAI_API_KEY`. All tiers currently use `gpt-4o-mini`; the tier changes depth, not model.
Without the key uploads still complete and links work, but every AI summary is skipped (no credit
is charged), so check it before announcing anything. Use a project key; if the project restricts
models, allow `gpt-4o-mini`. The SDK (`@ai-sdk/openai` v2) calls the **Responses API**
(`/v1/responses`), not Chat Completions, so a restricted key needs write access to Responses. A
refused or budget-capped call does not fail the upload either: the document completes without a
summary.

Every `openai(...)` call in `src/lib/ai` passes `store: false` (`src/lib/ai/openaiProviderOptions.ts`), so the
Responses API does not retain the extracted text and page images of customer PDFs or show them in
the project's dashboard logs. That holds only for calls made by a build that includes it: anything
sent by an earlier build (a sandbox or preview on the same project) stays stored for 30 days. A new
`openai(...)` call in `src/lib/ai` must pass `providerOptions: OPENAI_PROVIDER_OPTIONS` too; nothing
checks it. Still keep the OpenAI project's membership to the people who may read customer documents.

### 4.6 Email (Resend)

Every outbound email goes through Resend's HTTP API: a confirmation to the requester and a notice
to the owner on a download request, the approval link to the requester, view emails and
doc-update emails (each immediate, or a daily digest after 23:00 UTC), plan-limit grace emails and
workspace invites.

**View emails are on by default.** Every workspace member, existing and new, reads
`viewEmailMode` = `daily` unless they turn it off, and no migration or opt-in step stands in
front of the first send. Notifications are queued, not caught up to: a `NotificationQueue` row is written when the event
happens and drained by the cron. (This replaced `NotificationEmailCursor`, which is deprecated —
anything describing a first tick that creates cursors and sends nothing predates it, and with it
the quiet grace period where events from before the deploy were never emailed. On a database
starting empty there is nothing to catch up on either way; on one with history there is.) Size
Resend before deploying, not after:

- **Daily digests**: up to one per member per workspace per UTC day. Count members across all
  workspaces with share traffic; that number alone is the daily floor once links are being opened.
- **Immediate**: members who switch to `immediate` get up to one email per document per 5-minute
  tick while new recipients keep opening links, on every plan. Each row carries its own retry and
  backoff, and one that keeps failing ends as a `dead` letter rather than blocking the queue behind
  it. Members on `off` have nothing enqueued, so turning emails back on never sends what happened
  while they were off.
- The Resend free tier (100 emails a day) is not enough for launch: put the account on a paid plan
  whose daily and monthly quota covers the member count above plus the other email kinds, with
  headroom. Over quota, sends fail and are retried, within limits. A failed immediate email
  retries every 5 minutes from the first document that failed. A failed daily digest retries only
  on the remaining 23:00–23:59 UTC ticks, then on the next day's 23:00 run. A row that keeps failing
  ends as a `dead` letter rather than retrying forever.
- The cron reads every live membership, unsorted, capped at `limitMembers` (default 600). Above
  600 memberships across all workspaces, some members get no view, doc-update or request emails
  on a tick, and nothing reports it; raise the limit or fix the query before that point.
- Every view email carries a signed one-click **Turn off these emails** link
  (`/api/notifications/views/off`, no sign-in, 30 days; `LNKDRP_NOTIFICATION_TOKEN_SECRET` or
  `NEXTAUTH_SECRET`, 3) and a **Change how often** link. The Terms and Privacy pages state that
  these emails are on by default; they ship in the same release, so never deploy the pipeline
  without them.

**DMARC is not one of Resend's records, and its absence sends mail to spam.**

Resend's three records cover DKIM and SPF. Note where SPF lands: on `send.updates.lnkdrp.com`,
the Return-Path subdomain SES bounces to, *not* on the From domain. That is correct and it is why
`dig TXT updates.lnkdrp.com` looks empty — SPF is checked against the envelope sender, so it
aligns there. Both show **verified** in Resend.

DMARC is the one nobody creates for you, and Gmail treats a missing DMARC policy as a reason to
filter — this was found the hard way, with every test send landing in spam while all three Resend
records were green. Add it on the organisational domain, where receivers look it up:

```
name:  _dmarc                 <- relative, NOT _dmarc.lnkdrp.com
type:  TXT
value: v=DMARC1; p=none; rua=mailto:dmarc@lnkdrp.com; fo=1
```

**Enter the name relative to the zone.** Squarespace (and most registrar UIs) append the domain
for you, so typing the fully-qualified `_dmarc.lnkdrp.com` creates
`_dmarc.lnkdrp.com.lnkdrp.com` — a record that resolves perfectly if you query that exact name,
and is invisible to every receiver, which look up `_dmarc.lnkdrp.com`. This happened on the first
attempt. The existing rows are the pattern to copy: `send.updates`, `resend._domainkey.updates`
and `_vercel` are all relative. Verify with `dig +short TXT _dmarc.lnkdrp.com` and accept nothing
but the policy string coming back.

`p=none` is deliberate for the first weeks: it asks receivers to report, not to reject, so a
misconfiguration cannot silently destroy real mail. Read the `rua` reports, confirm everything
legitimate passes, then tighten to `p=quarantine` and later `p=reject`. DNS for `lnkdrp.com` is
Google Cloud DNS (`ns-cloud-c*.googledomains.com`).

Two more things that decide whether mail lands, neither of them DNS:

- **Do not judge deliverability by sending to an address on your own domain.** Google Workspace
  applies extra scrutiny to inbound mail that claims to be from a domain it hosts, so
  `c@lnkdrp.com` is the harshest possible test inbox and not a representative one. Send to a
  gmail.com address and somewhere else entirely before concluding anything.
- **`scripts/send-test-emails.ts` prefixes `[TEST]` by default**, and a subject beginning with a
  bracketed word in capitals is itself a mild spam signal. Pass `--raw` when what you are testing
  is deliverability rather than copy.

1. Add the sending domain `lnkdrp.com` in Resend and create the DNS records it asks for (SPF and
   DKIM). Wait for "Verified"; unverified domains
   silently drop to spam or fail.
2. Create an API key with send access. Env on the web app: `RESEND_API_KEY`, `EMAIL_LOGO_URL`
   (4.4 — without it, production mail loads its logo from the development Blob store),
   `NOTIFICATION_EMAIL_FROM` (`LinkDrop <hi@lnkdrp.com>`), `INVITE_EMAIL_FROM` (same, or a
   dedicated address). Invites read only `INVITE_EMAIL_FROM`; everything else uses
   `NOTIFICATION_EMAIL_FROM`, falling back to `INVITE_EMAIL_FROM`. No email sets a Reply-To, so
   replies go to the From address: give it a real inbox.
3. Leave `EMAIL_TRANSPORT` **unset** in production. `EMAIL_TRANSPORT=console` logs instead of
   sending and is for local development. It logs the
   full body, and download-request emails carry live Approve, Deny and claim URLs that work without
   sign-in, so in production those tokens would land in Vercel logs and any Log Drain. Without
   `RESEND_API_KEY`, sending throws.
4. Look at every template once, as the admin, at `/a/emails` — it renders each one from the
   catalog and flags any without a preview, which is the only way to notice a template that was
   added without one. Two are recent and have never been sent from production: `member_removed`
   (to the person removed from a workspace) and `waitlist_approved` (the welcome, sent by the
   approve button in `/a/waitlist`). Both quote workspace and product names, so read them with the
   live `NOTIFICATION_EMAIL_FROM` in place rather than assuming the copy is fine.

## 5. Web app on Vercel

1. Import the repository; framework preset Next.js; root directory `/`; Node 22 (see 2 on
   `engines`). Clicking Deploy on the import screen starts a production build immediately: add the
   step 3 variables in its Environment Variables panel first, or let that build go and treat step 6
   as the real one. Confirm in the deployment's Build Logs, which name the Node.js version the build
   used: it must be 22.x. Nothing in the app logs `process.version`, and `/api/health` does not
   return it.
2. Domains: `lnkdrp.com` (primary) and `www.lnkdrp.com` redirecting to it. Create the apex and
   `www` DNS records Vercel → Domains shows, wait until both read Valid Configuration with a
   certificate, and check `curl -sI https://lnkdrp.com` answers with `server: Vercel` before the
   Stripe webhook, the Google callback or any step in 8 can work.
3. Environment variables (Production; Preview is in 5.3). Required unless marked optional.
   `.env.example` is the development template and is incomplete for production; this table is
   the source of truth. Enter values by hand from this table. Never import `.env.local` or
   `.env.example` into Vercel (Import .env, or `vercel env add` from a file): the developer file
   sets `API_TEST_BYPASS_AUTH`, `API_TEST_USER_ID`, `DEBUG_LEVEL`, `BLOB_BASE_URL` and sandbox
   Stripe ids.

> **A missing variable here fails the build, not the first request, and blames the wrong page.**
> `src/app/layout.tsx` imports `authOptions`, so `next build` evaluates `src/lib/auth.ts` while
> collecting page data for every page. Without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or
> `NEXTAUTH_SECRET` the build stops with `Failed to collect page data for /_not-found` and the real
> reason two levels down in a `cause` chain. A 404 page is not the cause; those three are. They are
> checked as a set and reported together, so one failed build names all of them rather than costing
> a deploy per variable. Set every row below **before** the first deploy.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://lnkdrp.com` |
| `NEXTAUTH_URL` | `https://lnkdrp.com` |
| `NEXTAUTH_SECRET` | generated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from 4.3 |
| `MONGODB_URI` | from 4.1, with `/lnkdrp` in the path |
| `BLOB_READ_WRITE_TOKEN` | from 4.4 |
| `OPENAI_API_KEY` | from 4.5 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_AI_CREDITS_PRICE_ID` | from 4.2; a missing credits price fails Pro Checkout silently (4.2 step 8) and pay-as-you-go loudly, with a 400 |
| `CRON_SECRET` | generated; Vercel Cron sends it as `Authorization: Bearer` automatically |
| `CRON_MONITOR_SECRET` | generated (3). Opens only the read-only `/api/monitor/crons` and cannot run a job; give this one to the uptime monitor. Unset, the monitor route accepts only `CRON_SECRET` |
| `REALTIME_SECRET` | generated; same value on the services hosts, and different from `NEXTAUTH_SECRET` (3) |
| `NEXT_PUBLIC_REALTIME_URL` | `wss://realtime.lnkdrp.com` (set it in the first build once section 6 is live; unset, the app polls) |
| `NEXT_PUBLIC_APP_URL` | `https://lnkdrp.com`. Required: Checkout and portal return URLs fall back to the request origin (wrong behind a preview or proxy), but the Stripe webhook's rerun of skipped summaries after a credit pack or a pay-as-you-go activation falls back to `http://localhost:3001`, so without it purchased credits arrive and the reruns silently never start |
| `RESEND_API_KEY`, `NOTIFICATION_EMAIL_FROM`, `INVITE_EMAIL_FROM` | from 4.6; leave `EMAIL_TRANSPORT` unset |
| `LNKDRP_SHARE_PASSWORD_SECRET`, `LNKDRP_ORG_INVITE_TOKEN_SECRET` | generated (3); rotate only after a leak |
| `LNKDRP_NOTIFICATION_TOKEN_SECRET` | optional; generated (3). Signs the one-click off link in view emails; unset, it falls back to `NEXTAUTH_SECRET` |
| `ERROR_LOGGING_ENABLED` | `true`. The default is off outside development, so production records nothing in `errorevents` without it (Vercel Logs still get the one-line error summaries, 11 Logs) |
| `STRIPE_CREDITS_METER_EVENT_NAME` | optional; defaults to `ai_credits` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | optional; no current page reads it (Checkout is created on the server) |
| `NEXT_PUBLIC_MCP_URL` | optional; default `https://mcp.lnkdrp.com/mcp`. Without it, `/connect` shows `http://localhost:8787/mcp` on any origin other than `NEXT_PUBLIC_SITE_URL` (a `*.vercel.app` or preview URL) |
| `MONGODB_DB_NAME` | leave unset. The realtime server ignores it and takes the database from the URI path. A URI without `/lnkdrp` plus this variable makes realtime watch another database: sockets connect, `/healthz` is ok, and no live events arrive |
| `BLOB_BASE_URL` | leave unset. When set, it replaces the host derived from `BLOB_READ_WRITE_TOKEN`, so a value from another store (the dev `.env.local` has one; `docs/deploy/Deploy_1.md` recommends setting it) makes production reject every upload to its own store. If you set it, it must be exactly this store's `https://<storeId>.public.blob.vercel-storage.com` |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | optional; leave unset. They apply only when both are set; one alone is ignored and both redirects come from `NEXT_PUBLIC_APP_URL` |
| `NEXT_PUBLIC_FEATURE_REQUESTS` | leave unset at launch. `1` turns Requests on; it is build-time, so it needs a fresh build, the two Requests backfills in 5.2 first, and the same value on MCP (`fly secrets set NEXT_PUBLIC_FEATURE_REQUESTS=1 -a lnkdrp-mcp`, or `[env]` in `deploy/fly/mcp.fly.toml` plus `fly deploy`) |
| `NEXT_PUBLIC_FEATURE_CREDITS` | optional; credits UI is on by default, `0` hides it — including every "Add more credits" button, so the only way to `/credits` is typing the URL |
| `WAITLIST_ENABLED` | **ignored.** The queue is unconditional: every new account is queued and waits for an admin at `/a/waitlist` (which sends the `waitlist_approved` email). This was a flag, unset meant open, and production's first sign-in walked straight in because nobody had set it — a lock that depends on a variable being present is not a lock. Existing accounts are never retroactively queued, and admins are never held |
| `WAITLIST_ALLOW_EMAILS`, `WAITLIST_ALLOW_DOMAINS` | optional; comma- or space-separated. Addresses and domains that skip the queue — your own team, an investor, a design partner. Domains are bare (`lnkdrp.com`, not `@lnkdrp.com`) and matching is case-insensitive. Now that the queue has no off switch these are the only standing way in, so a domain left here is a door nobody remembers opening; `/a/env` reports what is set |
| other `ERROR_LOGGING_*` | optional; see `docs/ERROR_LOGGING.md` |

`NEXT_PUBLIC_*` values are inlined at build time into the browser bundle and the server routes
(the realtime ticket, Stripe return URLs, email links). After changing one, redeploy with a fresh
build. Promoting an older deployment brings back the values it was built with. Any other Vercel
env change also reaches functions only on the next deployment.
`NEXTAUTH_SECRET` also signs the short-lived server-to-server token the app uses to re-run
processing (writing a skipped summary, and the batch rerun when a Free workspace's pay-as-you-go
subscription becomes billable), so rotate it on a deploy, not mid-traffic.

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

4. Crons come from `vercel.json`; see 5.1. **Vercel Pro is required** because eight of the eleven
   jobs run more than once a day (`notification-emails` every 5 minutes). PDF processing, URL
   import, uploads, compare reruns and all ten cron routes declare `maxDuration = 300`.
   Processing continues in `after()` inside that same 300 s budget, so a deck that cannot be
   processed in 5 minutes fails on any plan unless `maxDuration` is raised (Pro with Fluid compute
   allows up to 800 s). Do not raise `maxDuration` on a cron route without raising that route's
   `LEASE_TTL_MS` (6 minutes, "slightly above maxDuration") above it and checking the stuck threshold
   in `src/lib/cron/jobs.ts`: `stuckAfterMs` is `min(RUNNING_STUCK_AFTER_MS, intervalMs + STUCK_MARGIN_MS)`,
   so a frequent job such as `notification-emails` is marked stuck after 6 minutes whatever
   `RUNNING_STUCK_AFTER_MS` says; both assume 300 s. Past 360 s the lease expires mid-run, and the next
   `notification-emails` tick runs alongside the current one and sends twice.
5. Deployment Protection: keep the default **Standard Protection**. It already leaves the
   production domain `lnkdrp.com` unprotected, which the self-calls below need, while old
   production deployment URLs and previews stay behind Vercel Authentication. Do not disable
   protection and do not choose All Deployments: a deployment keeps the env it was built with, so
   public old deployment URLs would run with old secrets against the live database. The app
   calls its own `/api/uploads/:id/process` from the server: a summary-only rerun (the doc page's
   "Write summary" action) and a batch of them when a workspace buys a credit pack (or a Free
   workspace's pay-as-you-go subscription becomes billable), re-running whatever was skipped for
   want of credits (from the Stripe webhook,
   not a cron — nothing here is cron-triggered any more). A protected deployment answers both with
   a login page and the reruns silently never start. The webhook's reruns also silently never
   start when `NEXT_PUBLIC_APP_URL` is unset (step 3 table). Protection on previews is fine;
   neither feature works there.
6. Deploy. If the import screen already built one (step 1), Redeploy it with the build cache off,
   so the build carries the step 3 `NEXT_PUBLIC_*` values. The first production build takes a few
   minutes because of the PDF and canvas native packages.

### 5.1 Cron jobs

Every job is one HTTP route, one schedule, one runner script (`scripts/cron/cron.<job>.ts`) and
one `cron:<job>` npm script, and `tests/lib/cronMap.test.ts` fails when they drift:

| Job | Schedule (`vercel.json`, UTC) | `--dry-run` | `--limit` | Lease |
|---|---|---|---|---|
| `doc-metrics` | `0 */6 * * *` | ignored | yes | no |
| `stripe-credits-reconcile` | `15 */6 * * *` | ignored | yes (max 1000) | yes |
| `stripe-credits-report` | `30 * * * *` | ignored | yes (default 200, max 500) | yes |
| `credits-cycle-reconcile` | `10 * * * *` | yes | yes (default 200, max 1000) | no |
| `usage-agg-reconcile` | `20 * * * *` | ignored | ignored; use curl with `?days=N` or `?start=&end=` | no |
| `notification-emails` | `*/5 * * * *` | yes | ignored; use curl with `?limitMembers=N&limitEventsPerOrg=N` | yes |
| `plan-limits` | `40 * * * *` | yes | yes (default 500, max 5000) | yes |
| `analytics-reconcile` | `50 3 * * *` | yes | ignored; no bound (it scans all history) | no |
| `credits-purchase-expiry` | `5 4 * * *` | ignored | yes | no |
| `account-purge` | `30 4 * * *` | yes | yes (default 25) | no |
| `credits-stale-reservations` | `25 * * * *` | yes | yes (default 500) | no |

Never pass `--dry-run` to a job marked "ignored" expecting a preview: the runner still adds
`?dryRun=1`, the route ignores it and does the real work, including Stripe meter events and credit
grants.

- **Production:** Vercel Cron calls `GET /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`
  on the schedule. Every route records a `CronHealth` row and accepts `POST` as well. The four
  jobs marked "Lease" hold a Mongo lease (6 minutes) and answer `{ skipped: "locked" }` while
  another run holds it. The other six have no lease but are idempotent, so a double run repeats
  work without double-granting or double-sending (an account already purged no longer matches
  `account-purge`'s query).
- **`account-purge` is the one job that destroys data.** It removes the blobs and then the rows of
  accounts whose 30-day deletion grace period has run out; nothing undoes it short of an Atlas
  restore, and the blobs are not in that restore (11, Backups). Run it by hand only with
  `?dryRun=1`, which reports what it would remove and writes nothing, not even a `CronHealth` row.
  `?userId=<id>` purges one already-due account, for a support case. Watch its `lastResult`
  (`due`, `purged`, `blobsDeleted`, `blobErrors`): a non-zero `blobErrors` means rows went and
  files stayed, which nothing retries.
- **By hand, any environment:** from a checkout, with `CRON_SECRET` exported (3),
  `npx tsx scripts/cron/cron.<job>.ts --target=https://lnkdrp.com` (add `--dry-run` only where
  the table says yes, `--limit=N` to shrink a run only where the table says yes; the other jobs
  silently do the full run). Do not use
  `npm run cron:<job>` against production: the alias loads `--env-file=.env.local`, exits with
  `.env.local: not found` where that file is missing, and without `--target` calls
  `CRON_TARGET_URL`, then `NEXT_PUBLIC_SITE_URL`, then `http://localhost:3001`. Without a
  checkout, use curl: `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/<job>`.
  Against a local dev server the secret is optional. The runners only call the route; they never
  re-implement a job. Send the secret in `Authorization: Bearer`. The routes also accept the
  legacy `x-cron-secret` header. A `?secret=` query parameter works only outside production:
  wherever `NODE_ENV` or `VERCEL_ENV` is `production` (previews included) it is ignored and the
  call answers 401, because a URL, secret included, lands in request logs, log drains and monitor
  configs.
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
  5 4 * * *    curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/credits-purchase-expiry
  30 4 * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/account-purge
  25 * * * *   curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://lnkdrp.com/api/cron/credits-stale-reservations
  ```
  `credits-stale-reservations` matters more than its position in this list suggests: credits
  reserved for an AI run that died are only returned by this job. Leave it unscheduled and
  workspaces lose credits permanently, one dead run at a time, with nothing surfacing it but the
  admin anomalies page.
  `scripts/cron/README.md` leaves `analytics-reconcile`, `credits-purchase-expiry` and
  `account-purge` out of its
  crontab, says every route takes a lease (four do; see the table above) and calls a double
  scheduler harmless, and its lines need `.env.local`; use this list. Keep the schedules identical to `vercel.json` and run one scheduler
  only: a second one is skipped by the leased jobs and only repeats work in the others.
- Job details and manual-trigger examples: `docs/CRON.md` (it predates `analytics-reconcile`,
  `credits-purchase-expiry` and `account-purge`; this section wins where they differ). `docs/deploy/Deploy_1.md` says only two jobs take a lease; four do.

### 5.2 One-time data jobs

A fresh production database needs only the migrations (4.1). If production starts from a
database that already holds documents, take an Atlas snapshot first (4.1 step 4), then run these
once, in order, from a trusted machine and a checkout of the release commit (with `npm ci` run in
it, 0 A), before the first
production deploy (0 B). None of them needs the web app. If an older build still serves that
database, run steps 4–5 again after the deploy, then step 9. Each is idempotent. The
flags differ: steps 4 and 5 **write unless you pass `--dry-run`**; steps 2, 3 and 6 to 8 only
preview unless you pass `--apply`. Always run the preview form first and read its output. The
`npm run` aliases hard-code `--env-file=.env.local`, so call the scripts directly with a
production env file:

| Step | Command | What it fixes |
|---|---|---|
| 1 | `node --env-file=prod.env db/migration/run.mjs` | Indexes and data migrations, including `sharelinks` (20260913). Without `--env-file` the runner reads `.env.local` and migrates that database instead |
| 2 | `node --env-file=prod.env scripts/project-shareid-backfill.mjs`, then `--apply` | Projects from before public project links have no `shareId`; the unique index cannot build and `/p/:shareId` fails for them |
| 3 | `node --env-file=prod.env scripts/project-doc-count-recount.mjs`, then `--apply` | Recomputes the cached `Project.docCount` shown in project lists |
| 4 | `npx tsx --env-file=prod.env scripts/sharelinks-backfill.ts` (`--dry-run` first) | Creates the default share link row for documents from before multiple links. `problems` must be empty; `no orgId` means step 1 did not run against this database |
| 5 | `npx tsx --env-file=prod.env scripts/sharelinks-analytics-backfill.ts` (`--dry-run` first) | Gives old analytics rows their `shareLinkId`, `orgId` and `lastViewedAt`, flags owner previews and reconciles link counters. Runs only after step 4: it attributes rows to the links step 4 creates. On `--dry-run`, `updated` shows what would change and `after` still shows the current gaps. On the real run, `after` must be all zeros and `orphanShareIds` and `mismatches` empty; a second run reports zero |
| 6 | `npx tsx --env-file=prod.env scripts/docchange-from-upload-repair.ts`, then `--apply` | Old version-change rows pointed "from" at the new upload |
| 7 | `npx tsx --env-file=prod.env scripts/credit-balances-reconcile.ts`, then `--apply` | Team workspaces seeded with Free starter credits; Free workspaces missing the 15-a-day cap. Add `--reset-compare-tier` only if no Free user has chosen a compare tier on purpose: it moves every Free row stored as "standard" back to the plan default (a replacement cost 6 instead of 3) |
| 8 | `npx tsx --env-file=prod.env scripts/ai-ask-repair.ts`, then `--apply` | Stored summaries with an operating cost taken as the funding ask, and invented "Funding ask"/milestone metrics |
| 9 | `npx tsx --env-file=prod.env scripts/verify-share-analytics.ts` | Read-only. Must print "All share-analytics invariants hold" (see 9.1) |

`scripts/request-docs-projectids-backfill.mjs` and `scripts/doc-received-via-request-backfill.mjs`
repair Requests data. Requests are hidden at launch; run them (same form, dry run then `--apply`)
before turning `NEXT_PUBLIC_FEATURE_REQUESTS` on.

`prod.env` is a local file with at least `MONGODB_URI` and `MONGODB_DB_NAME=lnkdrp`. Git and Docker
ignore that name (3); delete it afterwards anyway. `--env-file` never overrides a variable already set in
your shell: run the jobs in a fresh shell, or prefix each command with
`env -u MONGODB_URI -u MONGODB_DB_NAME`, and check the preview output shows production-sized counts
before applying. That covers the shell only: `run.mjs`, `project-shareid-backfill.mjs` and
`project-doc-count-recount.mjs` also load `.env.local` from the repo root and fill in anything
`prod.env` leaves unset, including a `MONGODB_DB_NAME` that overrides the URI's `/lnkdrp` (4.1
step 5). The two backfills print `Connected (dbName=…)`, so check it; `run.mjs` prints nothing, so
confirm the target with the `mongosh` line in 4.1 step 5 first.

### 5.3 Preview environment

Scope every variable to Production or Preview on its own. Never use All Environments for these:

| Variable | Preview value |
|---|---|
| `NEXT_PUBLIC_SITE_URL`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL` | a stable preview host (a branch URL or `staging.lnkdrp.com`, also listed in Google, 4.3), never `https://lnkdrp.com`. Share URLs, Stripe returns and email links are built from them |
| `MONGODB_URI` | a separate Atlas database |
| `STRIPE_*`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | sandbox keys and prices, and a sandbox webhook to the preview host. Vercel Authentication answers that webhook with a login page: keep protection on, enable Protection Bypass for Automation and add its secret to the sandbox webhook URL (`?x-vercel-protection-bypass=…`) |
| `BLOB_READ_WRITE_TOKEN`, `BLOB_BASE_URL` | a separate Blob store (4.4); `BLOB_BASE_URL` unset, or that store's own URL |
| `NEXT_PUBLIC_MCP_URL` | a staging MCP server whose `LNKDRP_API_URL` is the preview host, or leave unset and know that `/connect` on the preview host shows the production MCP, which calls `https://lnkdrp.com` and rejects preview keys with an auth error |
| `NEXTAUTH_SECRET`, `CRON_SECRET`, `CRON_MONITOR_SECRET`, `REALTIME_SECRET`, `LNKDRP_*_SECRET` | different from production |
| `NEXT_PUBLIC_REALTIME_URL` | unset (previews poll) |
| `ERROR_LOGGING_ENABLED`, `ERROR_LOGGING_ALLOWED_ENVS` | `true` and `preview`, only if you want preview errors recorded |

### 5.4 Index check

**One index must be dropped by hand.** `activityevents` carried `orgId_1_createdDate_-1`, which is
now a prefix of `orgId_1_createdDate_-1__id_-1` and does nothing the wider one does not do.
`autoIndex` creates and never drops, so both will exist until someone removes the old one, and every
activity write pays for both:

```
mongosh "$MONGODB_URI" --quiet --eval 'db.activityevents.dropIndex("orgId_1_createdDate_-1")'
```

Safe to run at any time and safe to skip: the cost of leaving it is write amplification on the
busiest collection, not a wrong answer.

Migrations create only some indexes. Mongoose `autoIndex` is on, so every function builds the rest
of the model indexes at cold start. A unique index that hits duplicate data fails **silently**,
and the guarantee it gives (Stripe webhook dedupe, credit grant idempotency, one balance per
workspace) is gone. `autoIndex` builds a model's indexes only when a function that imports that
model starts. The billing unique indexes (`stripeevents`, `creditpurchases`, both `creditledgers`
keys, `workspacecreditbalances`, `subscriptions`) and `sharelinks_label_audience_text` now come
from migration `20260916_0001`, which creates those collections, so they exist before traffic;
`cronhealths` still appears only after the first cron. Run this after the migrations and the
first real traffic (8 step 4), again after the first Stripe purchase (8 step 10) and the first
cron round (8 step 14), and after every release that changes `src/lib/models/`:

```
mongosh "$MONGODB_URI" --quiet --eval '
const want = {
  stripeevents: ["eventId_1"],
  creditledgers: ["workspaceId_1_idempotencyKey_1", "workspaceId_1_eventType_1_cycleKey_1"],
  workspacecreditbalances: ["workspaceId_1"],
  subscriptions: ["orgId_1"],
  apikeys: ["keyHash_1"],
  cronhealths: ["jobKey_1"],
  creditpurchases: ["stripeCheckoutSessionId_1"],
  orgs: ["personalForUserId_1", "slug_1"],
  orgmemberships: ["orgId_1_userId_1"],
  users: ["email_1"],
  docs: ["shareId_1"],
  projects: ["shareId_1"],
  docChanges: ["docId_1_toVersion_1", "docId_1_toUploadId_1"],
  sharelinks: ["shareId_1", "sharelinks_label_audience_text"],
  shareviews: ["shareId_1_botIdHash_1", "docId_1_lastViewedAt_-1", "shareId_1_lastViewedAt_-1"],
  sharevisits: ["shareId_1_botIdHash_1_visitIdHash_1"],
  usageaggdailies: ["workspaceId_1_day_1"],
  usageaggcycles: ["workspaceId_1_cycleKey_1"],
  ratelimits: ["key_1", "expiresAt_1"],
  errorevents: ["createdAt_1"],
  notificationemailcursors: ["orgId_1_userId_1_key_1"],
  sharedownloadrequests: ["requestTokenHash_1", "claimTokenHash_1"],
  orginvites: ["tokenHash_1"],
  billingconfigs: ["key_1"],
  projectviews: ["projectId_1_viewerUserId_1_sessionIdHash_1"],
  projectlinkviews: ["shareId_1_botIdHash_1"],
  starredDocs: ["orgId_1_userId_1_docId_1"],
  reviews: ["docId_1_version_1"],
  // Tags. Both indexes are unique and both carry a guarantee the UI depends on: one tag per name
  // per workspace, and tagging the same thing twice being the same fact rather than two rows.
  tags: ["orgId_1_slug_1"],
  tagassignments: ["tagId_1_targetKind_1_targetId_1"],
  // Notification dedupe: without it the same view can be emailed twice.
  notificationqueues: ["dedupeKey_1"],
  // One verified address per person per workspace.
  sharevieweremails: ["orgId_1_email_1"],
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
}
// The migration (20260129_0001) makes this one partial; the model alone would declare it sparse.
const cth = db.sharedownloadrequests.getIndexes().find((x) => x.name === "claimTokenHash_1");
if (cth && !cth.partialFilterExpression) print("NOT PARTIAL", "sharedownloadrequests", "claimTokenHash_1");'
```

No output means every index is there. `NO COLLECTION` is fine only for a feature nobody has used
yet; it is never fine for the collections `20260916_0001` creates (`stripeevents`,
`creditpurchases`, `creditledgers`, `workspacecreditbalances`, `subscriptions`, `sharelinks`):
there it means that migration did not run against this database. Re-run after 8 step 14, when
`cronhealths` must exist with no `MISSING`. `starredDocs` is camelCase on purpose (the model names
its collection).
While `sharelinks_label_audience_text` is missing, searching links by label or audience (the
`/links` search box and the MCP link lookup) fails with "text index required for $text query"
instead of returning nothing. A collection holds only one text index; if a hand-built one with
other fields exists, the migration's `createIndex` fails on it: drop the old text index, then
re-run the migrations.
For each `MISSING`, run the same `createIndex` by hand in mongosh to see the error. An E11000 names
the duplicate key: fix or merge those rows (snapshot first), then re-run. The `projects`
`{userId, name}` and `{userId, slug}` indexes and the model's `orginvites` partial index never
build (MongoDB rejects `$exists:false` and `$ne` in partial filters); that is expected and not
listed above.

### 5.5 Admins

Admin tools are `/a` (cron health, deployments, credits, data, AI runs, emails, share views,
account deletions) and `/api/admin/*`. An admin is a
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

5. Refresh the Pro price label from live Stripe: as the admin, open `/a/tools/billing` and click
   Refresh from Stripe (`POST /api/admin/billing/pro-price`). Expect `$29/mo`. `/pricing`,
   `/credits` and the dashboard subscription card read only this stored label from
   `billingconfigs`; without it `/pricing` shows "Monthly" and "price shown at checkout". Repeat whenever `STRIPE_PRICE_ID` changes.
6. The admin account must be a Google Workspace account on a domain you control (not a personal
   Gmail), with 2-Step Verification enforced, preferably a security key: admin rests on nothing but
   that Google sign-in plus the role, and `/api/admin/*` can delete users and workspaces and change
   credits. Review `db.users.find({ role: "admin" })` monthly.

To remove an admin, set `role` back to `"user"`. The API stops accepting them on the next call.
Keep the list short.

### 5.6 Web Analytics

`@vercel/analytics` is mounted in the root layout and reports visitors and page views for the
marketing and app pages. Turn it on in the Vercel dashboard under the project's Analytics tab; there
is no key and nothing to configure in the app. It is inert outside production, so previews and local
development post nothing.

Keep it straight from the product's own numbers, because they answer different questions and will
never agree. This counts people visiting LinkDrop. `ShareView` and `ShareVisit` count a recipient
reading a document somebody shared, which happens on pages this script also runs on and on bytes it
does not. If the two are ever compared in a meeting, that is the sentence to say.

### 5.7 Vercel API token, for the Deployments page

`/a/deployments` shows the last deployments with their state, target, commit and build duration.
That is the one thing the admin area cannot learn from its own database, because only Vercel knows
it.

**Entirely optional.** With no token the page says "not configured" and names these variables, and
nothing else in the admin area changes. Do not treat a missing token as a broken deploy.

1. vercel.com, your avatar, **Account Settings**, then **Tokens**.
2. **Create Token**. Name it for the job, e.g. `lnkdrp-admin-readonly`. **Scope it to the team that
   owns the project**, not your whole account, and set an expiry you are willing to rotate on.
3. `VERCEL_PROJECT_ID`: Project Settings, General, "Project ID" (`prj_…`). Or read
   `.vercel/project.json` after `vercel link`.
4. `VERCEL_TEAM_ID`: Team Settings, General (`team_…`). **Required when the project belongs to a
   team**, omitted for a personal account. Leaving it out on a team project is the usual cause of a
   403, and the page says so when it gets one.
5. Set all three in Vercel project env vars, production scope. They are read server side only.

```
VERCEL_API_TOKEN=...
VERCEL_PROJECT_ID=prj_...
VERCEL_TEAM_ID=team_...        # team projects only
```

**Know what you are handing over.** Vercel tokens are not granular: there is no read-only token
type. The token carries the access of whatever you scope it to, and it is read-only here only
because `src/lib/vercel/client.ts` issues nothing but GETs. Scope it to one team, give it an expiry,
and treat it like any other production secret — it never reaches the browser, is never logged, and
every string the client takes from a Vercel response is scrubbed of it before it reaches an admin
payload (a commit message containing the token would otherwise have been echoed back, which a test
caught).

Rotating it is safe at any time: the page degrades to "not configured" until the new value deploys.

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

Decision: **Fly.io**, one machine each for realtime and MCP in `iad` (closest to Vercel's `iad1`
function region and to Atlas in us-east-1, 4.1). Both configs live in `deploy/fly/`. Move to Railway or a VM
by reusing the same Dockerfiles; nothing in the code is Fly-specific.

### 6.2 Deploy on Fly

Run every `fly` command from the repository root: both Dockerfiles build from there, because each
imports a module or two out of `src/lib`. The root `.dockerignore` keeps `node_modules`, `.next`,
`.git`, every `.env*` and the `prod.env`, `realtime.env` and `mcp.env` files (3) out of the context,
so a working checkout is safe to deploy from — but
whatever you add to it, keep the paths those Dockerfiles `COPY` out of the ignore list, or the
build fails on a missing file.

```
fly launch --no-deploy --copy-config --config deploy/fly/realtime.fly.toml \
  --dockerfile realtime/Dockerfile --name lnkdrp-realtime
# Only with a strict Atlas allowlist (4.1 step 2 b); skip both lines under 0.0.0.0/0:
fly ips allocate-egress -a lnkdrp-realtime -r iad   # static outbound IPv4, $3.60/month
fly ips list -a lnkdrp-realtime                     # add the egress IPv4 to the Atlas allowlist
# realtime.env holds MONGODB_URI (the read-only lnkdrp-realtime user, /lnkdrp in the path) and REALTIME_SECRET
fly secrets import -a lnkdrp-realtime < realtime.env; rm -f realtime.env   # delete it even if the import failed
fly secrets list -a lnkdrp-realtime                 # exactly MONGODB_URI and REALTIME_SECRET; never NEXTAUTH_SECRET
fly deploy --ha=false --config deploy/fly/realtime.fly.toml --dockerfile realtime/Dockerfile \
  --image-label "$(git rev-parse --short=7 HEAD)"
fly scale show -a lnkdrp-realtime                   # expect one machine
curl https://lnkdrp-realtime.fly.dev/healthz        # 200, "ok":true, "mongo":"connected", "draining":false, all seven "streams" true
fly certs add realtime.lnkdrp.com -a lnkdrp-realtime
# CNAME realtime → lnkdrp-realtime.fly.dev, DNS-only (not proxied); CAA, if any, must allow letsencrypt.org
fly certs check realtime.lnkdrp.com -a lnkdrp-realtime  # repeat until the certificate is issued
curl https://realtime.lnkdrp.com/healthz
```

The comments at the top of `deploy/fly/*.fly.toml` point here and hold no commands; this block and
the one in 7 are the only copies.

`/healthz` answers 503, not 200, while the machine is draining on SIGTERM and whenever the Mongo
connection is down, so the named fields say which of the three facts is false. A missing ticket
secret is refused at boot with `REALTIME_SECRET (or NEXTAUTH_SECRET) is required` — the process
used to start, report healthy, and die on the first browser that connected, so a crash loop whose
first log line is a stack trace from a request is the old symptom, not the current one.

- Fly outbound IPs change unless allocated as above, and without an allocation `fly ips list`
  shows only inbound addresses. With a strict allowlist, add the egress IP to Atlas before the
  first deploy; under `0.0.0.0/0` (4.1 step 2) the allocation adds nothing. Without it the server exits on start and Fly restarts it in
  a loop (`fly logs -a lnkdrp-realtime` shows `[realtime] fatal`); a good start logs
  `mongo connected`.
- `MONGODB_URI` must end in `/lnkdrp`: the realtime server does not read `MONGODB_DB_NAME`.
- The server checks only `MONGODB_URI` at boot. Without `REALTIME_SECRET` `/healthz` answers, but
  the first browser connection crashes the machine; a secret that differs from Vercel's rejects
  every socket with 401. 8 step 7 catches both.
- `fly deploy` creates two machines on an app's first deploy unless `--ha=false` is passed. Two
  realtime machines work but double the change streams; for MCP see 7. If `fly scale show`
  reports two, run `fly scale count 1 -a <app>`.
- For later realtime deploys add `--strategy bluegreen`: the new machine must pass `/healthz`
  before the old one is destroyed, so a broken image or a bad Mongo connection leaves the old
  machine serving (realtime connects to Mongo before it listens). The default rolling strategy
  replaces the only machine in place. MCP stays on the default (one machine; sessions drop either
  way).

Then set `NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com` in Vercel before the web app's first
production build (0 D). If the web app is already deployed, set it and redeploy with a fresh
build. Until then the app polls and everything still works.

### 6.3 Deploy with Docker anywhere else

Host it anywhere that can keep a WebSocket open and reach Atlas. Single instance for launch. Add
`--platform linux/amd64` to `docker build` when you build on one machine (an Apple Silicon Mac)
and run on another.

```
docker build -f realtime/Dockerfile -t lnkdrp-realtime .
# realtime.env: MONGODB_URI=mongodb+srv://…/lnkdrp (read-only user) and REALTIME_SECRET=…
docker run -d --restart unless-stopped -p 127.0.0.1:8788:8788 \
  --env-file realtime.env lnkdrp-realtime
```

Or with the compose file that runs both services. Put `MONGODB_URI`, `REALTIME_SECRET`,
`LNKDRP_API_URL`, `MCP_PUBLIC_URL` and `NEXT_PUBLIC_REALTIME_URL` in `.env.production.services` at
the repository root, then run from the repository root:

```
docker compose -f deploy/docker-compose.yml --env-file .env.production.services up -d --build
```

Without `--env-file` Compose looks for `deploy/.env`, the secrets are empty and realtime exits on
start.

Bind the published port to loopback (`127.0.0.1:8788:8788`, as above) when the TLS proxy runs on the
same host. `deploy/docker-compose.yml` still publishes `8788` and `8787` on every interface (12), so
under Compose, or when the proxy is a separate load balancer, restrict the ports with a security
group or cloud firewall. Docker-published ports skip ufw/iptables INPUT rules, so a host firewall
alone does not stop plaintext access to the WebSocket and MCP endpoints, tickets and bearer keys
included.

Put TLS in front (Caddy, nginx, the host's load balancer) so the public address is
`wss://realtime.lnkdrp.com`; the proxy must pass WebSocket upgrades and keep idle connections
longer than 30 seconds (the server pings every 25). Verify with `/healthz`, then set
`NEXT_PUBLIC_REALTIME_URL` in Vercel as above.

Details, frame formats and scaling notes: `docs/REALTIME.md`.

## 7. MCP server

Same host class as the realtime server; on Fly, from the repository root (6.2). It never talks to
Atlas, so it needs no egress IP for the Atlas allowlist. It does need one for the Vercel Firewall
rule in 12; allocate it in 0 G, before that rule.

**`mcp/Dockerfile` copies `src/lib/limits/uploads.ts` (12) — done, keep it that way.** The server
imports it (`mcp/src/main.ts`, `tools/sharePdf.ts`, `tools/replacePdf.ts`) for the upload ceilings
in 4.4. The `COPY` is at `mcp/Dockerfile:41`; before it was added the build succeeded — nothing
type-checks the image — and the container then died on start with
`Cannot find module '../../src/lib/limits/uploads'`, which on Fly is a machine restarting in a
loop and `/healthz` never answering. `tests/lib/imageImportClosure` now fails the local gate when
either image's `COPY` list stops covering what its entrypoint imports, so this is caught before a
deploy rather than by one — but the test can only check the list, so add the line next to the
other three `COPY`s, or the block below cannot finish:

**Redeploy the MCP whenever its tool list changes.** The server registers its tools at start, and
a client caches the list it was given, so a tool added since the running image was built does not
exist to any agent — with no error to see, because the tool is simply absent. The tag tools
(`lnkdrp_list_tags`, `lnkdrp_tag`, `lnkdrp_untag`) are the most recent additions; after the deploy,
confirm they are there by listing tools from a client rather than with `curl`, which sees a
per-client cache (`docs/MCP.md`).

```
fly launch --no-deploy --copy-config --config deploy/fly/mcp.fly.toml --dockerfile mcp/Dockerfile --name lnkdrp-mcp
# mcp.env holds REALTIME_SECRET only
fly secrets import -a lnkdrp-mcp < mcp.env; rm -f mcp.env   # delete it even if the import failed
fly secrets list -a lnkdrp-mcp                          # exactly REALTIME_SECRET; never NEXTAUTH_SECRET
# NEXT_PUBLIC_FEATURE_REQUESTS stays unset at launch; lnkdrp_whoami reports requests as off.
# If you turn Requests on in Vercel, set the same value here too, or agents are told they don't exist:
# fly secrets set NEXT_PUBLIC_FEATURE_REQUESTS=1 -a lnkdrp-mcp (or [env] in mcp.fly.toml, then fly deploy).
fly deploy --ha=false --config deploy/fly/mcp.fly.toml --dockerfile mcp/Dockerfile \
  --image-label "$(git rev-parse --short=7 HEAD)"
fly scale show -a lnkdrp-mcp                            # must be exactly one machine
fly logs -a lnkdrp-mcp --no-tail                        # `listening on :8787` with realtime: 'wss://realtime.lnkdrp.com'
curl https://lnkdrp-mcp.fly.dev/healthz                 # proves the service before DNS is involved
fly certs add mcp.lnkdrp.com -a lnkdrp-mcp
# CNAME mcp → lnkdrp-mcp.fly.dev, DNS-only (not proxied); CAA, if any, must allow letsencrypt.org
fly certs check mcp.lnkdrp.com -a lnkdrp-mcp            # repeat until the certificate is issued
```

The startup log must show `realtime: 'wss://realtime.lnkdrp.com'`, not `off (polling only)`. That
proves only that a secret is present; a wrong value shows up later as
`realtime: socket error, polling continues` (8 step 8). `REALTIME_SECRET` lets its holder sign a
ticket for any workspace and listen to its live events, including new share ids. It only speeds up
`lnkdrp_share_pdf` and `replace_pdf` (they return on the ready frame instead of polling every 2 s);
treat the MCP host as holding a cross-tenant secret, or leave `REALTIME_SECRET` unset there if
polling is acceptable.

**Everything else the server reads.** `deploy/fly/mcp.fly.toml` `[env]` already sets `NODE_ENV`,
`MCP_PORT` (8787), `LNKDRP_API_URL` (`https://lnkdrp.com`), `MCP_PUBLIC_URL`
(`https://mcp.lnkdrp.com`) and `NEXT_PUBLIC_REALTIME_URL` (`wss://realtime.lnkdrp.com`); `[env]`
applies only on deploy (9). The rest are optional and unset by default:

| Variable | On `mcp.lnkdrp.com` |
|---|---|
| `LNKDRP_ALLOW_LOCAL_FILES` | **leave unset.** See below — setting it hands agents the container's filesystem |
| `LNKDRP_GHOSTSCRIPT` | unset unless `gs` is not on `PATH`; it names the binary to run |
| `LNKDRP_PDF_OPTIMIZE_DPI` | unset (220); clamped to 72–600 |
| `NEXT_PUBLIC_FEATURE_REQUESTS` | unset at launch, and the same value as Vercel if you turn it on |
| `LNKDRP_API_KEY` | never; it is for `--stdio` mode, where one key serves the whole process |

**`filePath` reads files off the MCP server's own disk, so it is gated.** `lnkdrp_share_pdf` and
`lnkdrp_replace_pdf` accept `filePath` as well as `sourceUrl` and `fileBase64`, and the server
opens that path itself — an agent's "path on my machine" only means anything when the server *is*
that machine. `isLocalFileAccessAllowed` (`mcp/src/tools/sharePdf.ts`) permits it when
`LNKDRP_ALLOW_LOCAL_FILES` is `1`/`true`/`yes`, or when `LNKDRP_API_URL`'s host is `localhost`,
`*.localhost`, `127.0.0.0/8`, `0.0.0.0` or `::1`. On the hosted server neither holds, so `filePath`
is refused with a `validation` error that tells the caller to use `sourceUrl` — which is the
correct behaviour.
**Never set `LNKDRP_ALLOW_LOCAL_FILES` on `lnkdrp-mcp`**, in `[env]` or with `fly secrets`: it
turns an agent-supplied absolute path into a read of the container's filesystem, and the tool then
uploads what it read, as a document, to that agent's own workspace. The only checks left are that
the path is absolute, the file is under `UPLOAD_MAX_BYTES` and its first bytes are `%PDF-`; nothing
validates the path itself. So the exposure is every PDF the container can reach — today an image
with no customer data in it, tomorrow whatever a volume or a debugging mount adds. The same applies
to any shared staging MCP. The flag is for a server the caller runs themselves, which is the local
`npm run mcp` case.

**PDF optimization uses Ghostscript, and the image has it.** Before an inline upload the
server shells out to `gs` (`mcp/src/optimize.ts`): `-dPDFSETTINGS=/prepress` with images
downsampled to `LNKDRP_PDF_OPTIMIZE_DPI` (default 220), a 120 s timeout, page count verified
against the original, and the result kept only if it is a valid PDF with the same page count and at
least 5% smaller. Files under 1 MB are not touched. It is a **soft dependency**: with no `gs` on
`PATH` (and none at `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, or wherever
`LNKDRP_GHOSTSCRIPT` points), the upload still happens and the tool result says
"Ghostscript (gs) is not installed on the MCP server, so the file was sent as-is." Every other
failure — timeout, changed page count, no saving — is soft the same way.

`mcp/Dockerfile` installs both: `apk add --no-cache ghostscript` (verified at build time with
`gs --version`) and `pdfjs-dist` in the generated `package.json`, which is what lets optimization
verify the page count on both files before accepting a smaller one. Without that check Ghostscript
would do the work on every upload and the result would always be thrown away with "The original was
sent unchanged: the page count could not be verified on both files."

This matters most on the inline path, because optimization is what brings a 6 MB deck under
Vercel's 4.5 MB body cap; `sourceUrl` never needed it. Ghostscript is a large package with its own
fonts, so if the image is rebuilt, check its size against the `shared-cpu-1x` 512 MB machine's
headroom.

Or with Docker anywhere (add `--platform linux/amd64` as in 6.3):

```
docker build -f mcp/Dockerfile -t lnkdrp-mcp .
# mcp.env: REALTIME_SECRET=…
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -e NODE_ENV=production -e LNKDRP_API_URL=https://lnkdrp.com \
  -e MCP_PUBLIC_URL=https://mcp.lnkdrp.com \
  -e NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com --env-file mcp.env \
  lnkdrp-mcp
```

1. TLS in front so clients reach `https://mcp.lnkdrp.com/mcp`. Sessions are held in memory,
   so run exactly one instance or use sticky sessions on `Mcp-Session-Id`. A second machine
   without sticky routing answers `404 Session not found` to agents at random; on Fly fix it with
   `fly scale count 1 -a lnkdrp-mcp`.
2. Once `fly certs check` shows the certificate issued, `GET https://mcp.lnkdrp.com/healthz` →
   `{ ok: true, sessions, version, apiUrl }`.
3. Capacity: the app uses request-based concurrency (`soft_limit` 1000, `hard_limit` 2000 in
   `deploy/fly/mcp.fly.toml`) on a machine that cannot scale out. Each connected agent can hold one
   open `GET /mcp` stream, which counts as an in-flight request, so past about 2000 connected agents
   fly-proxy queues or refuses new tool calls, which looks like a random outage. Watch
   `sessions` on `/healthz` as that number approaches.
4. The public guides at `https://lnkdrp.com/mcp/<client>` already point clients here.

The server has no database access: every tool call is a REST call to the web app with the
caller's own key. Details: `docs/MCP.md`.

## 8. Verify the release

Run in this order; each step depends on the previous.

0. Open `/a/env` as an admin (or run `npm run preflight:env` against the production environment) and
   confirm **zero failing rows**. It checks more than presence: Stripe keys in the wrong mode, a
   Mongo URI pointing at the wrong database, a webhook endpoint missing events, a site URL on
   `http://` or with a trailing slash. Warnings are for things that are optional or deliberate, and
   are worth reading once. Do this before anything below, because every step after it assumes the
   environment is right.
1. `curl https://lnkdrp.com/api/health` → 200 with `"ok":true`, `"mongo":"ok"`,
   `"env":"production"`, and `"version"` equal to `git rev-parse --short=7 HEAD` of the commit you
   released (null means the deploy was not built from git). Then
   `curl -sI https://lnkdrp.com/ | grep -iE 'frame|content-type-options|referrer'`
   → all four security headers (they apply to every path, so no share link is needed yet) (11, Security headers). They come from `next.config.ts`, so a
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
4. Run the index check in 5.4; it must print nothing but `NO COLLECTION` for features nobody has
   used yet. Steps 10 and 14 run it again.
5. Replace the file once: expect the AI compare on `/doc/:id/history` and **46 credits** (summary 1
   plus basic compare 2).
6. Open `/connect`, create a key, run the Verify curl. The pill reads "Key verified".
7. `curl https://realtime.lnkdrp.com/healthz` shows `"ok":true`, `streams` with `activity`,
   `apikeys`, `docs`, `projects`, `uploads`, `shareviews` and `projectlinkviews` all true, and
   `sockets` of at least 1 while your tab is open.
   Then, with DevTools → Network → WS open on `/activity`, open the share link again: an `activity`
   frame arrives within a second. A row that appears only after several seconds is polling, and
   realtime is not working. Upload another PDF with `/activity` open and watch the progress bar
   move on `upload` frames; `/api/uploads/in-progress` is the snapshot those frames update, and
   with no socket it is polled instead, so a working bar alone does not prove the socket.
8. `curl -s https://mcp.lnkdrp.com/healthz` → `ok: true`, `apiUrl: "https://lnkdrp.com"`, and
   `fly scale show -a lnkdrp-mcp` → exactly one machine. Add the MCP to Claude Code with that key,
   open a session; the sidebar Agents entry flips to
   "1 connected" with the client listed under it, without a click. Ask it to share a PDF by URL
   and confirm the link. While it shares, `fly logs -a lnkdrp-mcp` must not show
   `realtime: socket error, polling continues` (a mismatched `REALTIME_SECRET` shows as
   `Unexpected server response: 401`); the share still succeeds on polling, so nothing else shows it.
   Or run the harness against production from a trusted machine, with `prod.env` from 5.2:
   `E2E_ORG_ID=<your workspace id> E2E_USER_ID=<your user id> MCP_URL=https://mcp.lnkdrp.com/mcp npx tsx --env-file=prod.env tests/mcp/e2e.ts`.
   It mints and revokes its own key directly in that database and deletes the docs it creates; it
   spends real credits in that workspace and leaves activity rows. Without the two ids it uses the
   local dev workspace ids and fails. Its first step checks headroom: on a Free workspace it needs
   one open document slot (it creates a second document only after releasing the first) and stops
   there with the numbers rather than failing twenty steps in with a `plan_limit` that reads like
   a broken tool. Archive a document or use a Pro workspace. Its last line is a JSON summary
   with the step count; exit 0 is the pass.
9. Trigger one cron by hand and confirm 200 (with `CRON_SECRET` exported, 3):
   `curl -X POST 'https://lnkdrp.com/api/cron/plan-limits?dryRun=1' -H "Authorization: Bearer $CRON_SECRET"`.
   Without `?dryRun=1` it runs the real grace sweep, emails included. Then the analytics
   reconcile, which reports rather than just succeeding:
   `npx tsx scripts/cron/cron.analytics-reconcile.ts --dry-run --target=https://lnkdrp.com`.
   Both hand runs write the same `CronHealth` row (`status`, `lastRunAt`) a scheduled run does,
   so step 14 must tell them apart.
   Expect `linksReconciled: 0` and `pageTimeOverruns: 0` on a healthy deploy; see 9.1.
10. Stripe: buy Pro with a real card, confirm the subscription shows in the dashboard, the credits
    read 300, the Stripe return lands on `https://lnkdrp.com` (not a preview URL), and the webhook
    delivery log shows `checkout.session.completed` handled. The subscription must show two items,
    Pro and On-demand AI credits; only Pro means `STRIPE_AI_CREDITS_PRICE_ID` was missing on that
    deployment (4.2 step 8). The portal cancels at period end, which never sends
    `customer.subscription.deleted`, so do not change the production portal for a test: cancel
    the test subscription in the Stripe dashboard with Cancel → Immediately, confirm the webhook
    delivery log shows `customer.subscription.deleted` answered 200 and the workspace dashboard
    shows Free with on-demand off, then refund the charge in the Stripe dashboard. Then, on a Free account, open "Add more credits" from the dashboard and buy the
    30-credit pack with a real card: the page shows "30 credits added"
    within a few seconds, the sidebar credits go up by 30, and `creditpurchases` holds one row for
    that session. Refund it in the Stripe dashboard (the credits stay; see 12). Re-run the index
    check in 5.4: `stripeevents`, `creditpurchases` and `subscriptions` must now exist with no
    `MISSING`.
11. Email: request a download on a link with downloads off, from a private window; the owner
    receives the notice from `NOTIFICATION_EMAIL_FROM` in the inbox, not spam. Then set your
    member's view emails to "Immediately" in Preferences, open a share link of the test document
    from a private window, and within 5 minutes receive a view email for that document naming the
    link (the subject names a labelled link only when that email has one viewer). Switching from
    daily catches up: the first immediate tick also sends every other recipient open on the
    workspace since your last digest (up to 7 days), one email per document, so expect those too
    unless nobody else opened its links. Click
    **Turn off these emails** in it on a phone or a signed-out browser: the page says view emails
    are off, and Preferences now reads Off.
12. Recreate `prod.env`, run `npx tsx --env-file=prod.env scripts/verify-share-analytics.ts`
    against production (read-only), and delete the file again.
13. Revoke the test key from `/connect`; the sidebar returns to Not connected.
14. Vercel → Settings → Cron Jobs lists 10 jobs. Prove the scheduler, not your step 9 hand runs.
    An hour after the deploy, in Vercel → Settings → Cron Jobs → View Logs, each of the five jobs
    that run hourly or faster (below) has an invocation at its scheduled minute; check the other
    five the same way the next morning. Then read every job against its schedule:
    `curl -s -H "Authorization: Bearer $CRON_SECRET" 'https://lnkdrp.com/api/monitor/crons?strict=0' | jq '.jobs[] | {jobKey,state,lastRunAt}'`.
    The five jobs that run hourly or faster (`notification-emails`, `credits-cycle-reconcile`,
    `usage-agg-reconcile`, `stripe-credits-report`, `plan-limits`) must be `ok`, and `plan-limits`
    must show a `lastRunAt` at about :40, later than your step 9 run. `doc-metrics` and
    `stripe-credits-reconcile` may be `never-run` until their next 6-hour slot, and
    `credits-purchase-expiry` until 04:05 and `account-purge` until 04:30; `analytics-reconcile`
    reads `ok` only because of the step
    9 run. `/a/cron-health` (admin, 5.5) lists only jobs that have run and has no late state, so use
    it for `lastResult`. The next morning all ten are `ok`: `analytics-reconcile` with a
    `lastRunAt` after 03:50 UTC today and `lastParams.dryRun` false in `GET /api/admin/cron-health`
    (admin session; the page does not show `lastParams`), `credits-purchase-expiry` after 04:05,
    `account-purge` after 04:30 (on a fresh database it reports `due: 0`; `/a/deletions` shows who
    is waiting and when each purge is owed),
    each of those five with a View Logs invocation — and
    `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CRON_MONITOR_SECRET" https://lnkdrp.com/api/monitor/crons`
    answers 200 (this also proves the monitor secret works before the uptime monitor gets it). Re-run the index check in 5.4; `cronhealths` must exist with no `MISSING`. Point
    the uptime monitor at the cron monitor then, not before (11, Crons).

## 9. Release workflow

- `main` of the repository connected under Vercel → Settings → Git is production. Every push to
  `main` deploys the web app on Vercel; previews build from other branches with the preview env
  (5.3).
- There is no CI (`.github/` holds only a pull request template); the local gate is the only gate,
  and every push to `main` goes live before anything in 8 can run. Until a required check exists
  (12), protect `main` (require a pull request), or in Vercel → Settings → Environments →
  Production turn off auto-assigning the production domain, so a push builds a staged production
  deployment. Its generated URL sits behind Vercel Authentication (5 step 5) and is not a Google
  callback host (4.3), so before Promote run only 8 step 1, with a Protection Bypass for Automation
  secret (Settings → Deployment Protection) sent as the `x-vercel-protection-bypass` header, and 8
  step 4 (it reads the database, not the URL). Promote, then run 8 step 7 on `lnkdrp.com`.
  Before every push to `main`: `npx tsc --noEmit -p .`, `npx eslint src realtime mcp tests`,
  `npm run tests:lib:vitest`, `npm run tests:credits:vitest`, `npm run tests:upload:vitest`,
  `npx next build`, and
  `npx tsx --env-file=.env.local tests/mcp/e2e.ts` when the MCP or the API-key seam changed (it
  needs one open document slot on a Free workspace; 8 step 8). `npm run tests:agent:vitest` is not
  part of the gate: it makes live OpenAI calls (it needs `OPENAI_API_KEY`, costs credits and
  asserts LLM-judged results, so it can fail at random) for AI review, which is hidden at launch.
  Run it only when review prompts or `src/lib/ai` change.
- Before merging anything touching data shapes: add a migration under `db/migration/` and run it
  against production (4.1, snapshot first) before the deploy lands, since functions roll forward
  first. Mongoose `autoIndex` is on: any index declared in `src/lib/models/` is built by the first
  functions after the deploy, on live data, and a failure is silent. For a new index on a large
  collection (`shareviews`, `sharevisits`, `creditledgers`, `docpagetimings`, `activityevents`),
  or any new unique index, put the same index (same key, name and options) in a migration so it
  builds before traffic and a duplicate-key failure stops the runner where you can see it. Then run
  the index check (5.4). `20260916_0001` did this for the billing unique indexes and the
  `sharelinks` text index; copy its `ensureIndex` helper, which leaves an identical index alone.
- The realtime and MCP services do not auto-deploy. Run `fly deploy` (6.2 / 7) when a commit
  touches `realtime/`, `mcp/`, `src/lib/realtime/ticket.ts`, `src/lib/credits/schedule.ts`,
  `src/lib/credits/types.ts`, `src/lib/limits/uploads.ts`, `tsconfig.json`,
  `deploy/fly/realtime.fly.toml` or
  `deploy/fly/mcp.fly.toml` (their `[env]` applies only on deploy), or the resolved versions of
  `mongoose`, `ws`, `@modelcontextprotocol/sdk`, `express`, `zod` or `tsx` in `package-lock.json`.
  The Dockerfiles pin those direct dependencies to exact versions that must equal what the root
  lockfile resolves (mongoose 8.20.3, ws 8.21.3, sdk 1.30.0, express 5.2.1, zod 4.2.0, tsx 4.21.0),
  so a lockfile bump means editing the matching line in `mcp/Dockerfile` or `realtime/Dockerfile`;
  nothing checks they agree. The base image is pinned to `node:22.23.2-alpine`, but they still run
  `npm install` with no lockfile, so **every** `fly deploy`, even one with no change under `mcp/` or
  `realtime/`, can pick up newer transitive dependencies than the local gate tested (12). Deploy MCP outside busy hours.
  Build only from the release commit: `fly deploy` builds from the local working tree, so first run
  `git fetch && test -z "$(git status --porcelain)" && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"`,
  and label the image with `--image-label "$(git rev-parse --short=7 HEAD)"` (6.2, 7) so rollback
  can find it. The MCP image copies the credit schedule and the upload ceilings, so a price change
  without an MCP deploy leaves `lnkdrp_whoami` quoting old costs, and a change to
  `src/lib/limits/uploads.ts` leaves the tool descriptions and the Express body limit on the old
  number while the API enforces the new one. The services are backwards compatible with the web app
  across ordinary releases; deploy the web app first when both change. A services deploy restarts
  the single machine: every browser socket reconnects within a few seconds and every MCP session
  is dropped (clients get `404 Session not found` and must reconnect). Deploy MCP outside busy
  hours. Deploy realtime with `--strategy bluegreen` (6.2).
- After every production deploy, a short check (8 is for launch):
  1. `curl -s https://lnkdrp.com/api/health` → `ok`, `version` equals the pushed commit
     (`git rev-parse --short=7 HEAD`).
  2. `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CRON_MONITOR_SECRET" https://lnkdrp.com/api/monitor/crons` → 200.
  3. The index check (5.4) if `src/lib/models/` changed.
  4. After a `fly deploy`: both `/healthz` ok (realtime with all seven `streams` true), `fly scale show` one machine, and
     `fly releases --image -a <app>` shows the new label.
  5. Open a share link and confirm a view arrives on `/activity` within a second.
- Never point the analytics dev tools at production: `tests/share/traffic.ts` and
  `tests/share/seed-links.ts` write real share links and analytics rows to whatever
  `TRAFFIC_APP_URL`, `MCP_URL` and `MONGODB_URI` name, and `--spread` rewrites timestamps on rows they created.
  They are not part of any verification step here.
- Adding a cron job means a route with `runtime = "nodejs"`, `maxDuration` and `requireCronAuth`;
  a `vercel.json` entry; a `CRON_JOBS` entry in `src/lib/cron/jobs.ts` with the same schedule and
  the matching `intervalMs` (the monitor judges against it, and no test checks `intervalMs`); a
  `scripts/cron/cron.<job>.ts` runner and a `cron:<job>` npm script. `npm run tests:lib:vitest`
  fails when a jobKey is missing or a schedule differs. Decide whether it needs a lease. Add it to
  the 0 and 5.1 tables and the crontab (`scripts/cron/README.md` also omits `jobs.ts`).

### 9.1 Share analytics: the gate before shipping a change to them

Run `npx tsx --env-file=.env.<target> scripts/verify-share-analytics.ts` against the target
database before and after any release that touches the share analytics. `npm run verify:analytics`
always reads `.env.local`, so use it only for the local database. The check is read-only, safe against
production, and exits non-zero, so it also works as a CI step.

Expect `All share-analytics invariants hold` on a healthy database. It says that now; it could not
before 2026-09-21, and the reason is worth knowing because the failure mode was the dangerous kind
— loud where it should have been quiet, and silent where it should have been loud.

`ShareLinkModel.distinct("docId")` returns the `null` that every project link carries, and the
per-document check ran once on it. `find({ docId: null })` is every data-room link in the database;
the row aggregate beside it matched rows whose `docId` is null, of which there are none. So each
project link *with* traffic was reported as completely drifted (`viewCount is 10 but 0 recipient
rows exist`) and each one without passed by comparing zero to zero — meaning no project link's
counters were ever actually checked. The document rollups failed the same way for a different
reason: `freshViewerCount` and `freshVisitTimeMs` matched on `docId` alone, while the route they
claim to recompute applies `docOnlyShareIdMatch`, so a document in a data room was accused of
disagreeing with itself over the readers it is right to exclude.

Both are fixed. Project links are now verified against `projectLinkStatsByShareId` — the same
function the project read paths and `analytics-reconcile` already share, so "what a project link's
viewCount is" has one definition — and the two tools agree: the run that found `viewCount is 12 but
13 recipient rows exist` was followed by a reconcile reporting `stored: 12, actual: 13` and
repairing it. The recomputations apply document scope. Verified by injecting drift into one link of
each kind and confirming both were caught.

It asserts four properties, each of which failed silently in production shape at least once:

| Property | The bug it catches |
| --- | --- |
| Per-page time fits inside a row's total | The ingest counted an interval twice. Per-page time ran 26% over real dwell for weeks. |
| A link's counters equal the recomputation from its rows | A write path touched the link but wrote no row, so `/links` and the metrics page disagreed. |
| A document equals the sum of its links | The per-link table stopped adding up to the tiles above it. |
| Only signed-in rows carry the owner-preview flag | Something set the flag that cannot know the answer. |

Counter drift is repairable and the nightly `analytics-reconcile` job fixes it on its own; you can
force it with `npx tsx scripts/cron/cron.analytics-reconcile.ts --target=https://lnkdrp.com` (with
`CRON_SECRET` exported, 3).
A **page-time overrun is not repairable and is never repaired automatically**: it means the ingest
double counted, and overwriting the rows would hide the bug instead of fixing it. The job reports
those in `CronHealth.lastResult` and marks itself `error` so the run is visible.

Three files, in the order to read them. `src/lib/share/readingClock.ts` is the flush logic — a
pure state machine with its own unit tests, including a fuzz test whose invariant is exactly the
property above: reported page time never exceeds reported visit time.
`src/lib/analytics/shareTiming.ts` turns one post into the two increments and holds the rule that
timing *bounds* (`enteredAtMs` / `leftAtMs`) mean the reader **left** the page, which is what
promotes a post to a `pageEvents` segment and a revisit tick. `PdfJsViewer` only feeds the clock
browser events and posts what it flushes; there are no timing rules left in it.

The clock reports the page it is **still on** every 30-second heartbeat, not only on a page turn —
a document with one page has nowhere to turn to and recorded nothing at all until the tab closed.
A heartbeat's post therefore carries `pageDurationMs` with **no** bounds, and the clock keeps a
`pageReportedMs` ledger so the exit flush sends only what has not been sent yet. That ledger is
the thing to suspect first if this property ever fails again: reset it in one place and not
another and the page's whole dwell is sent twice. A heartbeat that starts arriving *with* bounds
is the other tell — every one of those writes a page exit that never happened.

The job rescans every settled row every night, so one overrun keeps `analytics-reconcile` at
`error`, and `/api/monitor/crons` at 503, every night until the rows are handled. Until then the
uptime alert on the cron monitor is permanently firing and cannot tell you about any other job
(billing, email). Once the bug is understood, record the row ids and decide how to clear them (a
one-off repair with a snapshot first); meanwhile watch the other jobs on
`/api/monitor/crons?strict=0` by hand. The code change that stops one old bug from blinding the
monitor is in 12.

## 10. Rollback

- **Web app:** Vercel → Deployments → the last good production deployment → Instant Rollback.
  Code rolls back; data does not. Then:
  - Automatic promotion is off after a rollback. Pushes to `main` still build but do not go live
    until you Undo Rollback or promote a deployment by hand.
  - The rolled-back deployment runs with the env values it was built with. If you rotated
    `REALTIME_SECRET`, `CRON_SECRET` or a Stripe key since, redeploy with current env instead.
    After a leak-driven rotation, never Instant Rollback to a deployment built before it (11,
    Secrets rotation).
  - Check Settings → Cron Jobs still lists every job.
- **Database:** migrations and the 5.2 jobs are forward-only and some rewrite data, so the older
  build runs against migrated data; it is safe only against additive changes. If a release's data
  change is what broke, restore, and accept losing ordinary writes made since. The lost writes
  include Stripe-backed rows (`subscriptions`, `creditpurchases`, credit ledger grants,
  `stripeevents`) and meter reporting marks, so a restore is not done until billing is
  reconciled:
  1. Disable Vercel Cron Jobs (Kill switches below) before the cutover, so
     `stripe-credits-report` cannot re-send usage the restore marked unreported: it claims those
     rows under a new batch id, which is a new meter identifier, and Stripe dedupes identifiers
     only for 24 h, so customers are billed twice. Cycle grants, `plan-limits` and notification
     emails could also fire again on restored data.
  2. Prefer an Atlas point-in-time restore to the minute before the bad migration or job over the
     older on-demand snapshot. Restore to a new cluster, allowlist it (4.1), point `MONGODB_URI`
     at it on Vercel and on `lnkdrp-realtime` (`fly secrets import` redeploys it), redeploy the web
     app, and run the index check (5.4).
  3. Replay lost webhook events: Stripe → Developers → Events in **live mode**, filtered from the
     restore time, in chronological order, for the seven events in 4.2 step 4. From the Stripe CLI
     use `stripe events resend <id> --live --webhook-endpoint <we_… id>` with a live key (`--api-key`
     from an exported variable, 3); without `--live` the CLI resends test-mode events.
     They apply once, because the restored `stripeevents` has no rows for them. Stripe lists
     events for 30 days. Credit-pack purchases after the restore point come back only this way.
  4. Before re-enabling crons, reconcile metered usage. Compare Stripe → Meters → `ai_credits`
     event summaries since the restore time with the rows the restored database still shows as
     unreported, including rows that already carry a `reportBatchId`:
     `db.creditledgers.find({ eventType: "ai_run", status: "charged", creditsFromOnDemand: { $gt: 0 }, stripeUsageReportedAt: null })`.
     Set `stripeUsageReportedAt` on the rows Stripe already received.
  5. Run `stripe-credits-reconcile` and `credits-cycle-reconcile` by hand (5.1), re-enable Vercel
     Cron Jobs, and check `/api/monitor/crons?strict=0`.
- **Services on Fly:** find the last good image, then deploy it without rebuilding:
  ```
  fly releases --image -a lnkdrp-mcp
  fly deploy --ha=false -a lnkdrp-mcp --config deploy/fly/mcp.fly.toml --image registry.fly.io/lnkdrp-mcp:<label>
  ```
  With `--image-label` (9) the tag is the commit SHA; older images are `deployment-<id>`. Same for
  `lnkdrp-realtime`. Do not roll back by rebuilding an old commit: the Dockerfiles pin only direct
  dependencies, with no lockfile and a floating base image, so a rebuild produces a different image.
- **Services with Docker:** tag every build with the commit
  (`docker build -f mcp/Dockerfile -t lnkdrp-mcp:$(git rev-parse --short HEAD) .`), keep the last
  two tags, and roll back with `docker run` on the previous tag.
- **Stripe:** never delete prices; archive them. Price ids are read from env only when a Checkout
  starts. Changing `STRIPE_PRICE_ID` or `STRIPE_AI_CREDITS_PRICE_ID` and redeploying affects new
  subscriptions only; existing ones keep their old items until you change them in Stripe.

**Kill switches.** Any Vercel env change needs a redeploy to take effect.

| Stop | How | Takes effect |
|---|---|---|
| All traffic to an abused or broken path | Vercel → Firewall → Custom rule: Deny `/api/<path>` (or Attack Challenge Mode for the site) | Immediately |
| Writes during a bad data release | Firewall Deny on `POST`, `PATCH` and `DELETE` to `/api/*` except `/api/stripe/webhook` and `/api/cron/*`, then roll back | Immediately |
| All Vercel crons (including Stripe usage reporting) | Vercel → Settings → Cron Jobs → Disable Cron Jobs; re-enable in the same place. After re-enabling, drain billing: run `npx tsx scripts/cron/cron.stripe-credits-report.ts --limit=500 --target=https://lnkdrp.com` until `processed` is below 500 | Immediately |
| One cron | Remove its `vercel.json` entry and deploy (`tests/lib/cronMap.test.ts` then fails until the route, runner and npm script go too) | Next deploy |
| Hand runs and external schedulers | Rotate `CRON_SECRET` and redeploy. This does **not** stop Vercel Cron, which sends the new value. An uptime monitor on `CRON_MONITOR_SECRET` is unaffected; one still sending `CRON_SECRET` goes red with 401 until you update its header | Next deploy |
| Realtime | Unset `NEXT_PUBLIC_REALTIME_URL` and redeploy the web app with a fresh build; browsers poll. The MCP server has its own copy (`deploy/fly/mcp.fly.toml`) and polls by itself when the socket fails | Next deploy |
| MCP | `fly scale count 0 -a lnkdrp-mcp`. `fly machine stop` is not enough: `auto_start_machines = true` starts it again on the next request. Keys stay valid for the REST API; revoke them at `/connect`. Scale-to-zero destroys the machine, so neither `fly machine start` nor `auto_start_machines` brings it back, and a plain `fly deploy` rebuilds with floating transitive dependencies. Restore with the current image: `fly releases --image -a lnkdrp-mcp`, then `fly deploy --ha=false -a lnkdrp-mcp --config deploy/fly/mcp.fly.toml --image registry.fly.io/lnkdrp-mcp:<label>`; `fly scale show` must report one machine and `https://mcp.lnkdrp.com/healthz` ok | Immediately |
| AI spend | Remove `OPENAI_API_KEY` and redeploy; summaries and compares are skipped and not charged (4.5) | Next deploy |
| Outbound email | Revoke the API key in the Resend dashboard (no redeploy). Sends then throw: emailed invites fail with 500 (the invite row is still created), `notification-emails` counts `sendFailures` every run and retries later, and download-request rows get `ownerEmailError`. Never use `EMAIL_TRANSPORT=console` in production: it logs full bodies, including live download Approve, Deny and claim URLs (4.6) | Immediately |

## 11. Operating notes

- **Health:** `/api/health` (web), `/healthz` (both services), and `/api/monitor/crons` (below).
  Point an uptime monitor at all four. Realtime `/healthz` reports each of its seven change streams
  (`streams: { activity, apikeys, docs, projects, uploads, shareviews, projectlinkviews }`), and is
  503 while any one of them is false. A `<name> stream error` log line alone is not an
  outage: the driver resumes transient errors itself. When a stream is still closed 30 s after an
  error or close, the server logs `<name> stream closed for good`, `/healthz` answers 503 with
  that stream `false`, and 5 s later the process exits so Fly restarts the machine with fresh
  streams; clients reconnect on their own. An uptime check may catch that brief 503 or the restart.
  If it repeats, read the error before the exit in `fly logs -a lnkdrp-realtime` (usually Atlas
  access or the URI). MCP `/healthz` `version` is fixed at `0.1.0`; use
  `fly releases --image -a lnkdrp-mcp` (image labels, 9) to see what is deployed.
- **Alerting:** name the tools and the recipient before announcing (0 G); "alert if your log drain
  supports it" is not a plan. Uptime: checks on `/api/health`, `https://realtime.lnkdrp.com/healthz`
  and `https://mcp.lnkdrp.com/healthz` every minute and `/api/monitor/crons` every 5 minutes,
  alerting a named on-call email or channel. Logs: a Vercel Log Drain (Settings → Log Drains) is
  required, with alerts on the rate of status ≥ 500 and on the strings `[realtime] fatal`,
  `stream closed for good`, `[mcp] fatal` and `[email] send failed`; ship Fly
  logs to the same provider (Fly's log shipper app), because `fly logs` streams recent output only.
  Stripe → Developers → Webhooks: make sure the delivery-failure email goes to a watched inbox.
- **Crons:** a 200 from a job does not mean the job worked, and Vercel Cron does not retry. Point
  an uptime monitor at `GET /api/monitor/crons` with `Authorization: Bearer $CRON_MONITOR_SECRET`,
  because a monitor cannot hold the admin session `/a/cron-health` needs. That secret opens only
  this route and cannot run a job, so the monitor vendor never holds one that triggers billing or
  email crons. The route also accepts `CRON_SECRET`; do not give that one to a vendor. Use a
  monitor that can send the header: `?secret=` is refused in production. It answers
  **200 while every job is healthy and 503 when any is not**, so an ordinary HTTP check alerts, and
  the body names the job, its state and `lastFinishedAt`: `late` (no run for two whole intervals;
  for a row left at `running`, no *finished* run for two intervals plus the stuck window), `error`,
  `stuck` (left at `running` for one interval plus a minute, at most 10 minutes, so the function
  died mid-run, usually at the 300 s limit), or `never-run`.
  Add `?strict=0` to read the same body with a 200 by hand. Expect red until the first full round
  of jobs has run, which is deliberate: the alternative is a monitor that stays green for a cron
  that never fired. `src/lib/cron/jobs.ts` holds the schedules it judges against, and
  `tests/lib/cronMap.test.ts` fails if they drift from `vercel.json`.
  A route's 200 does not mean nothing failed. `credits-cycle-reconcile`, `stripe-credits-reconcile`
  and `plan-limits` record `error` (with `lastError` such as `3 of 120 subscriptions failed`) when
  `errors` > 0, and `stripe-credits-report` does when `replayFailedBatches` > 0 (a stale claimed
  batch that failed to replay; those rows stay unbilled until a replay succeeds), so the monitor
  goes 503 while their HTTP answer stays 200. The state clears only on the job's next clean run: an
  hour for the hourly ones, up to 6 h for `stripe-credits-reconcile`. `notification-emails` still
  records `ok` with `sendFailures` > 0, so read its `lastResult`. `analytics-reconcile` answers 200
  while marking itself `error`. Check
  `/a/cron-health` (admin, 5.5) daily after launch, then weekly: every job `ok`, with `lastRunAt`
  inside its schedule, and read `lastResult` (`errors`, `sendFailures`), not just the pill. For
  billing, also check that
  `db.creditledgers.countDocuments({ eventType: "ai_run", status: "charged", creditsFromOnDemand: { $gt: 0 }, stripeUsageReportedAt: null, createdDate: { $lt: new Date(Date.now() - 3 * 3600e3) } })`
  is 0; it counts claimed batches that keep failing and never-claimed rows alike.
  `stripe-credits-report` with `processed` equal to its limit (200) means a backlog; drain it as in
  10 (Kill switches). `analytics-reconcile` scans all analytics history each night; watch its
  `lastDurationMs` and treat anything over about 120 s as the signal to bound it (12). Treat
  `error`, or a `lastRunAt` older than two intervals, on `stripe-credits-report`, `credits-cycle-reconcile` or `notification-emails` as an incident. A row
  left at `running` means the function died before writing a result, usually at the 300 s limit;
  run that job by hand with a smaller bound, using the `--limit` column in 5.1 (three jobs ignore
  `--limit`), and read the function log. A `notification-emails` run killed every time now shows:
  `stuck` after 6 minutes at `running`, and `late` once its `lastFinishedAt` is more than 16 minutes
  old, even though each new run resets `lastRunAt`. Leases expire on
  their own after 6 minutes; only a job answering `{ skipped: "locked" }` for longer needs
  `leaseUntil: null` set on its row in `cronhealths`.
- **Logs:** Vercel → Logs for the app; runtime logs are kept only briefly, so the Log Drain
  (Settings → Log Drains) in Alerting above is required. `fly logs -a lnkdrp-realtime` and
  `fly logs -a lnkdrp-mcp` for the services (`docker logs` off Fly); they stream recent output
  only. With `ERROR_LOGGING_ENABLED=true`, `errorevents` holds cron failures, Stripe webhook
  failures, share-password errors and every `errorJson` response with status ≥ 500 for 14 days,
  readable by an admin at `/api/admin/errors`. There is no page for them under `/a`. Every error a
  route returns through `errorJson` now writes one redacted `console.error` line (context, status,
  error name, message with keys, bearer tokens, credentials in URLs and email addresses
  stripped) whatever `DEBUG_LEVEL` is, so it shows in Vercel Logs with no debug setting. It never
  logs a stack at any level (a stack is kept only in `errorevents`, through `logErrorEvent`, when
  `ERROR_LOGGING_ENABLED=true`); request metadata is added only at `DEBUG_LEVEL` ≥ 1. Routes with their own try/catch are not
  covered: Stripe Checkout (`/api/stripe/checkout`) logs nothing and returns the raw message with a
  400, and upload processing logs its failure steps only at `DEBUG_LEVEL` ≥ 1 (12). A failed upload
  keeps its message on the `uploads` row (`error.message`). To reproduce those, use a preview with
  `DEBUG_LEVEL=1`.
- **Email failures:** every failed send except workspace invites logs one `[email] send failed` line in Vercel Logs with the
  HTTP `status`, Resend's error `code` (for example `validation_error`, or `config` for a missing
  `RESEND_API_KEY` or From address) and the email `kind` from the subject prefix; never the
  recipient, body or provider message. Do not set `DEBUG_LEVEL` in production for more: at level 1,
  `GET /api/docs/:id?debug=1` returns raw doc records with password hash fields (5, after the
  table). For the recipient and full error, use the Resend dashboard Logs. Download
  requests store the error on the `sharedownloadrequests` row
  (`requesterEmailError`, `ownerEmailError`, `claimEmailError`). `notification-emails` counts
  `sendFailures` in `CronHealth.lastResult` and retries those recipients on the next run. A failed
  emailed invite returns 500, but the invite row already exists and its link shows in the team
  page's pending list.
  Workspace invites are the exception: `src/lib/email/sendOrgInviteEmail.ts` calls Resend itself and
  throws `Failed to send email (<status>): <Resend body>`, and the invite route
  (`src/app/api/org-invites/email/route.ts`) does not catch it. The route answers 500 and the uncaught
  error, Resend's response body included, lands in Vercel Logs and any Log Drain. That body can echo
  the recipient's address, so treat invite failures in the logs as containing personal data.
- **Backups:** set up in 4.1 step 4. Restore: follow 10 (Database) — crons off first, point-in-time
  restore to a new cluster, allowlist it as in 4.1, check it with
  `npx tsx --env-file=.env.restored scripts/verify-share-analytics.ts`, point `MONGODB_URI` at it
  on the web app and the realtime server and redeploy both, replay Stripe events and reconcile the
  meter before crons go back on. Do one
  test restore before launch. Vercel Blob has no backup and is not in the Atlas restore. Ordinary
  use never deletes a blob — old versions and deleted documents keep theirs — but `account-purge`
  (5.1) does, permanently, 30 days after someone asks to delete their account. A database restore
  to a point before that purge brings the rows back pointing at files that no longer exist, and a
  store removed by hand is gone.
- **Costs and quotas:** before launch, set a monthly budget and email alert on the OpenAI project
  that owns `OPENAI_API_KEY`, a Vercel Spend Management amount, and billing alerts on Atlas (backup
  storage adds to the cluster cost) and the Fly organization. In Atlas → Alerts also add
  "Connections above 80% of the tier limit" (M10 allows 1,500) and "Replication oplog window below
  1 h". Put Resend on a plan above the free
  tier (100 emails a day); over quota, sends fail. View emails are on by default for every
  workspace member (4.6), so size the plan by member count, not by signups. Blob storage grows with
  every upload and is never reclaimed by ordinary use — old versions and deleted documents keep
  their blobs. The only path that removes one is `account-purge` (5.1).
- **Scaling:** the web app scales with Vercel, but each function instance can hold up to 10
  connections per replica-set member (`maxPoolSize` 10, released only after 30 s idle; the code
  does not use `attachDatabasePool`), and Fluid compute adds instances with traffic. Watch Atlas →
  Metrics → Connections during the first traffic spike. The MCP machine refuses new requests past
  `hard_limit` 2000, and each connected agent can hold one (7 step 3). MCP must stay at one machine (sessions are in
  memory) unless you add sticky routing on `Mcp-Session-Id`. Realtime can run more than one
  machine: each runs its own change streams and serves its own sockets, and each extra machine
  adds seven change streams on Atlas.
- **Secrets rotation:** `REALTIME_SECRET` must change on all three pieces in one go; tickets are
  60 seconds, so a brief mismatch only costs reconnects. Afterwards, while an agent shares a PDF,
  `fly logs -a lnkdrp-mcp` must not show `realtime: socket error, polling continues`; nothing else
  shows that MCP was missed. `NEXTAUTH_SECRET` rotation signs everyone
  out and voids summary reruns started in the last 5 minutes; if `REALTIME_SECRET` or the two
  secrets in 3 are unset, they fall back to it, so rotating it also breaks what those protect
  (and, while `LNKDRP_NOTIFICATION_TOKEN_SECRET` is unset, the one-click off links in view emails
  already delivered).
  Changing `LNKDRP_SHARE_PASSWORD_SECRET` (or adding it later) makes every recipient re-enter link
  passwords, and owners see existing link passwords as empty until they set them again; password
  checks keep working. Changing `LNKDRP_ORG_INVITE_TOKEN_SECRET` hides the links of pending invites
  in the workspace invite list; links already sent still work. `CRON_SECRET` rotation: update any
  external scheduler too (and the uptime monitor, if it still sends `CRON_SECRET`); they go 401 on
  the next deploy otherwise. `CRON_MONITOR_SECRET` rotation: update the monitor's header. Every
  rotation needs a redeploy.

  After a leak, also rotate the credential itself, then deal with old deployments:
  1. MongoDB: create a new user or password in Atlas, update `MONGODB_URI` in Vercel and
     `fly secrets import` on `lnkdrp-realtime` (its own read-only user, 4.1 step 1), redeploy
     both, then delete the old user.
  2. Stripe: roll the secret key and the webhook signing secret in the dashboard with a short
     expiry, update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Vercel, redeploy.
  3. Google (`GOOGLE_CLIENT_SECRET`), Blob (`BLOB_READ_WRITE_TOKEN`), OpenAI, Resend: create the new
     credential, update Vercel, redeploy, revoke the old one.
  4. A user's `lnk_` key: revoke it at `/connect`.
  5. Never Instant Rollback to a deployment built before a leak-driven rotation, and delete older
     deployments or keep them behind Standard Protection (5 step 5): they still carry the leaked
     values.
- **Security headers:** `next.config.ts` sends `Content-Security-Policy: frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin` on every response Next serves. Check after a
  deploy with `curl -sI https://lnkdrp.com/s/<shareId>`. Framing is SAMEORIGIN rather than DENY on
  purpose: the app frames its own pages (`/paperplane/index.html`, `/api/docs/:id/pdf`). Vercel
  adds HSTS on its own. The API sends no CORS headers on purpose: API keys are for servers and
  agents.
- **Rate limits:** all fixed-window counters in `ratelimits`, shared across functions, and all
  fail open if Mongo is unreachable. Every per-IP limit counts each IPv6 address as its own IP (no
  /64 grouping), so one host with an IPv6 prefix gets effectively unlimited buckets (12). Link
  unlock is 10 attempts per 5 minutes per IP per link, with no per-link ceiling; download requests
  are per IP; share stats are
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
- **Resolved: the `COPY` lists are checked by a test.** `mcp/Dockerfile` had to be taught to copy
  `src/lib/limits/uploads.ts`, and the hazard behind it — nothing checking that a `COPY` list
  covers what the entrypoint imports, with the build succeeding either way — recurred exactly as
  predicted: the realtime server gained an import of `share/projectPublic`, which could not simply
  be copied because it drags mongoose models behind it. `tests/lib/imageImportClosure` now walks
  the import graph from both entrypoints and fails when anything it reaches is missing from that
  image's `COPY` list, or when either image would pull in a database model. `import type` is
  ignored, since it is erased before the code runs. Run it with the other suites in the 0 A gate.
- **The 50 MB inline upload limit is not reachable on Vercel.** `src/lib/limits/uploads.ts` sets
  `UPLOAD_MAX_BYTES` to 50 MB for both `import-url` and `import-bytes`, and every message and MCP
  tool description quotes it, but Vercel Functions cap a request body at about 4.5 MB, so the
  inline path (`import-bytes`, and the MCP's `fileBase64` and `filePath`) fails past roughly 3 MB
  decoded with a platform 413 that carries none of our copy (4.4). Nothing in the app detects the
  host's cap, so the numbers it quotes stay wrong for that one path. Decide one of: quote the real
  inline ceiling when the deployment is Vercel, move the inline path to the browser's
  direct-to-Blob route, or accept it and rely on agents preferring `sourceUrl` (the tool
  descriptions already push them there, and the MCP shrinks what it can). Until then, expect
  support questions whose only visible symptom is a 413 with no lnkdrp error body.
- **Decision pending: Ghostscript is not in the MCP image.** PDF optimization is a soft dependency
  and skips cleanly with a note (7), so the current image is a working, supported configuration —
  but it is also the reason a mid-sized deck sent inline cannot be brought under Vercel's body cap.
  Decide before launch whether `mcp/Dockerfile` installs `ghostscript` and `pdfjs-dist`, or whether
  inline uploads stay small-files-only.
- Resend sending domain (4.6) and the Google consent screen publishing status (4.3) are not done.
- Check the sandbox Stripe Pro product description against 4.2 (older text said summaries never use credits).
- **If you ever add a real Content-Security-Policy**, know what it breaks first. The app sends only
  `frame-ancestors 'self'` today (11, Security headers). `public/paperplane/index.html` loads
  `three` from `https://esm.sh` at runtime, so a `script-src` that omits that host kills the
  marketing page's animation — and the page still renders, so the symptom is a blank space, not an
  error anyone will see. Vendor `three` locally first, or allow the host explicitly.
- **Decision pending:** view counts can be inflated by anyone who posts made-up visitor ids to
  `/api/share/:shareId/stats` (only a 120 requests per minute per IP limit applies, and every IPv6
  address counts as a separate IP). Decide on an abuse budget or tighter rate limits before relying
  on view counts for billing or reports. The same endpoint accepts any `viewerEmail`/`viewerName`
  without verification, so a view can be attributed to someone who never opened the link (it shows
  in the activity feed and viewer analytics). Nothing about that has changed; treat volunteered
  identities as unverified before building anything (alerts, CRM sync, billing) on them.
  **Partly answered in the UI, and only partly.** A device-keyed row that carries a name can only
  have got it by someone typing it in, so the reader page marks it: `IntroducedBadge`
  ("Introduced themselves", tooltip "Typed in by them, not verified") renders in
  `src/components/metrics/ViewerProfile.tsx` and nowhere else. Recent-visitor lists, the workspace
  card and the activity feed still print such a name exactly as they print a signed-in reader's,
  with no way to tell the claim from the fact. Either mark it in those three places too, or decide
  the reader page is the only surface where the distinction has to be visible — but decide, rather
  than leaving one marked surface to imply the others were checked.
- **Link passwords: the per-link cap landed; IPv6 is still the hole.** Three buckets now apply in
  `src/app/api/share/[shareId]/unlock/route.ts`: 10 tries per IP per link / 5 min, **100 tries per
  link across every source address / 15 min**, and 60 tries per IP across all links / 5 min. The
  middle one is the bound an attacker cannot buy their way out of with more proxies, and it is
  what stands in for a password length rule (`SHARE_PASSWORD_MIN = 1`, a settled product
  decision). Note the trade it makes: exhausting it locks that link for everyone until the window
  ends, so a sustained attack on one link is a denial of service against its real audience — the
  ceiling is set an order of magnitude above the busiest real send for that reason.
  Still open: `normalizeIp` in `src/lib/http/rateLimit.ts` keys on the whole address, so every
  IPv6 address in a /64 — one customer allocation — is a separate bucket and gets its own 10
  tries. Until it buckets IPv6 by /64, a Firewall rule on `POST /api/share/*/unlock` is what
  covers that.
- **Still to do in infrastructure:** the app now caps temp-workspace creation and API-key traffic
  itself (11, Rate limits), but every refused request has still woken a function and read Mongo.
  Add a Vercel Firewall rate-limit rule on `/api/*` per IP so abuse is refused before it costs
  anything. Exclude `/api/cron/*`, `/api/monitor/crons`, `/api/health`, `/api/stripe/webhook` and
  `/api/blob/upload` (or exempt the uptime provider's published IP ranges). Do not exempt the MCP
  server's outbound IP (allocated in 0 G) outright:
  give it its own, higher rule (for example 20× the per-IP limit), because every agent's REST call
  leaves from that one address, and keep the per-key limit (11) as the fine-grained control. The MCP
  server itself has no limit on failed `initialize` attempts, and invalid keys are rejected before
  the per-key limiter charges anything, so junk-key floods to `mcp.lnkdrp.com` reach the web app
  unthrottled; until the code limits them, watch `fly logs -a lnkdrp-mcp` for bursts of
  `initialize refused`. Also cover `/s/*/pdf` and `/p/*/*/pdf`, which the `/api/*` rule misses:
  both are public, have no
  in-app rate limit, stream the whole blob (PDFs up to 250 MB) through a function with
  `cache-control: private`, so no edge cache absorbs repeats, and with `?download=1` each hit also
  writes counters and activity. Nothing collects temp workspaces once created:
  watch the count of `users` with `isTemp: true` and write a reaper if it grows.
- **Resolved 2026-09-16**, previously listed here as a gap: Free workspaces can buy more credits
  directly (credit packs at `/credits`, 4.2); the monthly top-up this used to describe is gone.
- **Refunds and disputes don't take credit-pack credits back.** A refund issued in Stripe, or a
  chargeback, leaves the purchased credits in the workspace; nothing handles `charge.refunded` or
  `charge.dispute.created`. Remove them by hand from `/a/credits` when you refund. Decide before
  selling packs at volume whether refunds should claw credits back automatically.
- **Pay-as-you-go for Free is retired (2026-09-17).** On-demand is Pro-only, and credit packs are
  Free-only (`POST /api/credits/purchase` returns 409 `PACKS_FREE_ONLY` on Pro, where on-demand is
  cheaper per credit). Checkout refuses `plan: "payg"`. The reserve path, snapshot, Limits editor
  and billing summary all treat on-demand as off on any non-Pro workspace. An existing payg
  subscription therefore bills nothing new, and its owner can still turn the stored toggle off
  from Limits. The webhook still parses payg subscriptions; remove that code, and cancel any such
  subscriptions in Stripe, once none are left.
- **On-demand usage from the last hour can go unbilled when a Pro subscription is deleted
  outright.** `stripe-credits-report` runs hourly and only reports for `active`/`trialing`
  subscriptions, so usage recorded after its last run and before an immediate cancellation is
  never sent. A cancel at period end is fine. If immediate cancels become common, flush the
  workspace's unreported rows from the `customer.subscription.deleted` handler first.
- If production starts from an existing database, run the one-time data jobs in 5.2.
- **Resolved 2026-09-16** in code and config, previously listed below: the `deploy/fly/*.fly.toml`
  headers are pointers to 6.2 / 7; MCP concurrency is 1000/2000; the service Dockerfiles pin their
  direct dependencies to the lockfile versions; `scripts/gen-env-secrets.mjs` prints `CRON_SECRET`
  and `REALTIME_SECRET`; `.gitignore` and `.dockerignore` list `prod.env`, `realtime.env` and
  `mcp.env`; migration `20260916_0001` creates the billing unique indexes and the `sharelinks` text
  index; the cron monitor judges running rows by `lastFinishedAt`, and partial failures in
  `credits-cycle-reconcile`, `stripe-credits-reconcile`, `plan-limits` and `stripe-credits-report`
  record `error`; `credits-cycle-reconcile` checks the stalest period end first; `?secret=` is
  refused in production and `/api/monitor/crons` takes the read-only `CRON_MONITOR_SECRET`; every
  OpenAI call passes `store: false`; `errorJson` and `sendTextEmail` log a redacted line without
  `DEBUG_LEVEL`; realtime `/healthz` reports stream health and the process exits on a dead stream.
- **Code and config changes still open** (this runbook works around each one until it lands):
  - `mcp/Dockerfile`, `realtime/Dockerfile`: exact direct versions, but still `npm install` with no
    lockfile (transitive dependencies float), and nothing checks the pins against the root lockfile.
    The base image is pinned to `node:22.23.2-alpine`. Commit a `package.json` and
    `package-lock.json` per service generated from the root lock versions, `COPY` them and run
    `npm ci --omit=dev`. Optionally pass the commit SHA as a build arg and return it
    from both `/healthz` (9).
  - `package.json`: `engines` `"22.x"` (0 A). `vercel.json`: add `"regions": ["iad1"]` so a
    dashboard change or project re-import cannot move functions away from Atlas (4.1).
  - `deploy/docker-compose.yml`: publish `127.0.0.1:8788:8788` and `127.0.0.1:8787:8787` (6.3).
  - `docs/deploy/Deploy_1.md`: fix the `MONGODB_DB_NAME`, `BLOB_BASE_URL` and lease entries, or
    replace it with a pointer here. `mcp/README.md`: name only `REALTIME_SECRET` for the MCP host;
    optionally drop the `NEXTAUTH_SECRET` fallback in production in `src/lib/realtime/ticket.ts`
    and `mcp/src/config.ts`. `docs/REALTIME.md`: `/healthz` now also returns `streams` and can
    answer 503.
  - `db/migration/`: fix the comment in `20260913_0001_sharelinks_indexes.mjs` that says production
    runs with `autoIndex` off (it is on). Optionally make `db/migration/run.mjs` log the redacted
    host and database it connected to.
  - Cron monitoring: `src/app/api/cron/notification-emails/route.ts` still records `ok` when
    `sendFailures` > 0; record `error` as the other jobs now do. In `analytics-reconcile`, report
    overruns only on rows newer than the last run (or exclude acknowledged rows) and stream with a
    cursor instead of loading all history (9.1). `stripe-credits-report` logs a failed stale-batch
    replay only at `DEBUG_LEVEL` ≥ 1; the `error` state is the only production signal.
  - `src/lib/cron/auth.ts`: production still accepts the legacy `x-cron-secret` header (a header,
    so it stays out of URLs); drop it once nothing sends it.
  - Error visibility: `src/app/api/stripe/checkout/route.ts` logs nothing and returns the raw error
    message with a 400; route it through `errorJson`. The upload-processing failure path
    (`src/app/api/uploads/[uploadId]/process/route.ts`) logs only through `debugError`; log a
    redacted line there too, or add `src/instrumentation.ts` with `onRequestError`.
    `src/lib/email/sendOrgInviteEmail.ts` calls Resend directly and throws with Resend's response
    body, which the invite route does not catch, so the unredacted body (possibly the recipient's
    address) reaches the function log; send through `sendTextEmail`, which logs the redacted
    `[email] send failed` line instead.
  - `mcp/src/main.ts`: limit failed `initialize` attempts per client IP (`Fly-Client-IP`) before
    calling the API.
  - `.github/workflows/`: a gate workflow (tsc, eslint, the lib/credits/upload vitest suites,
    `next build`) as a required status check on `main` (9).
