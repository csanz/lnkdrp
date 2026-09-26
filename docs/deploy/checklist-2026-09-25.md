# Deploy checklist, 2026-09-25: `next-release` to `main`

The ordered list for shipping `next-release` into `main` (`fc72740`). The release is the commit the
PR merges; **reconciled against the branch on 2026-09-26, when that is `fbede1d`** (83 commits,
2026-09-23 to 2026-09-26, 543 files). The head has moved fifteen commits since this file was first
written against `7f98f91`; the counts, the migration list and the tool counts below are the
2026-09-26 ones. `fbede1d` was built for this pass and passes (see "Known red at time of writing"
at the end), so do not ship an older head. Confirm with `git rev-parse --short next-release` and
`git log --oneline main..next-release | wc -l`. `DEPLOY.md` at the repo root is the standing runbook and every
section number below points into it; this file is only what is different for this release. The
release notes a person can read are `docs/releases/2026-09-25.md`.

Written from the committed history (`git log main..next-release`), the seven `db/migration/20260925_*`
files, `docs/reviews/*-2026-09-23.md` and `*-2026-09-24.md`, `docs/CHANGELOG-2026-09-24.md` and
`-25.md`, and a grep of `process.env` in the diff. The working tree carried uncommitted edits from
another session while this was written; release from the committed SHA, not from the tree.

## 0. Before anything

- [ ] Local gate on the exact commit you will release (DEPLOY.md 9): `npx tsc --noEmit -p .`,
      `npx eslint src realtime mcp tests`, `npm test` (the lib, credits and upload suites, new
      umbrella script in `package.json`), `npx next build`, and
      `npx tsx --env-file=.env.local tests/mcp/e2e.ts` (the MCP and the API-key seam both changed;
      the harness asserts its `EXPECTED_TOOLS` list, which is 39 tools at `fbede1d`, and fails if
      the server exposes one that is not on it; the step total follows the plan, 58 on Pro over
      OAuth and 50 on Free in the 2026-09-24 runs). The same first three run in GitHub
      Actions on the pull request (`.github/workflows/test.yml`, new on this branch).
- [ ] Merge `next-release` into `main` through a pull request and note the SHA. `main` on `origin`
      is Vercel's production branch; the push builds and deploys the web app at once (9).
- [ ] From a clean checkout of that SHA, `npm ci`. The migrations, the Fly deploys and the smoke
      harness all run from it (DEPLOY.md 0 A explains why an older checkout silently skips newer
      migration files).
- [ ] Atlas: Backup, Take Snapshot Now, write the time down. Migration 0004 deletes data by
      design (below) and none of the seven has a down step.
- [ ] Decide the two optional env values you will set before step 1 runs: `AI_RUN_RETENTION_DAYS`
      (the migration reads it) and whether Slack is configured on this deploy.

## 1. Migrations

Run from the clean checkout, repo root, with `prod.env` holding `MONGODB_URI` and
`MONGODB_DB_NAME=lnkdrp-prod` (DEPLOY.md 4.1 step 5 has the reasoning; `.env.local` in that
directory would otherwise fill in what you did not set):

```
node --env-file=prod.env db/migration/run.mjs --dry-run       # lists 26 files, connects to nothing
mongosh "$MONGODB_URI" --quiet --eval 'db.getName() + " " + db.docs.estimatedDocumentCount()'
node --env-file=prod.env db/migration/run.mjs
```

The real run must print `skip (already applied)` for the nineteen files up to `20260917_0001` and
`run:` for exactly these seven, in this order (`run.mjs` sorts by filename and records each in the
`migrations` collection). All seven are safe to re-run.

| File | What it does | Idempotent | Can fail on data |
|---|---|---|---|
| `20260925_0001_orgmemberships_plain_indexes.mjs` | Drops the partial `userId_1` and `orgId_1` on `orgmemberships` (built by `20260107_0001` with `{ isDeleted: false }`, which the planner cannot use for the runtime's `isDeleted: { $ne: true }`; review M11) and recreates them plain, matching `index: true` in `src/lib/models/OrgMembership.ts`, so autoIndex stops hitting `IndexOptionsConflict` on every boot. | Yes: an index already plain is left alone | No (non-unique). There is a short window between drop and create on a collection read on every app load; run it before the deploy, not during traffic |
| `20260925_0002_analytics_activity_indexes.mjs` | Single-field indexes `shareviews.lastViewedAt_-1`, `sharevisits.lastEventAt_-1`, `sharelinks.lastViewedAt_-1` (the nightly `analytics-reconcile` selected by those fields alone and scanned both collections, M9) and `activityevents.type_1_createdDate_-1` (the admin funnel report). Same key and name as the models declare. | Yes | No (non-unique). On large `shareviews` and `sharevisits` the build takes time; the runner waits |
| `20260925_0003_projects_live_unique_names.mjs` | `updateMany` sets `isDeleted: false` where the field is missing, then drops and recreates the unique `projects.orgId_1_name_1` and `orgId_1_slug_1` with `partialFilterExpression: { orgId: { $type: "objectId" }, isDeleted: false }`, so a soft-deleted project frees its name (review Low). `src/lib/models/Project.ts` declares the same filter under the same names. | Yes | Not on data: the old index already forbade live duplicates. **Must run before the deploy**: autoIndex cannot change an existing index's options, so without this the old 409 stays and the conflict is silent |
| `20260925_0004_airuns_ttl.mjs` | Creates `airuns.createdDate_ttl` with `expireAfterSeconds` = `AI_RUN_RETENTION_DAYS` days (default 30), or `collMod`s an existing one to that value. `src/lib/models/AiRun.ts` declares the same index from the same variable. | Yes | No. **Data-destructive by design**: AI runs older than the retention, prompt text included, are swept by Mongo's TTL monitor within minutes of the build. Set `AI_RUN_RETENTION_DAYS` in `prod.env` before running if 30 is not the number, and set the same value on Vercel (a different value there means autoIndex fails silently and the migration's number stands) |
| `20260925_0005_request_repos_is_request.mjs` | `updateMany` setting `isRequest: true` on every project with a `requestUploadToken`; the backfill `GET /api/admin/data/requests` used to run on every page load. Returns `{ matched, modified }`. | Yes: marked rows match nothing | No |
| `20260925_0006_contacts_backfill.mjs` | Builds the `contacts` indexes (the unique `orgId_1_email_1` first) and backfills one row per person the workspace has already heard from, read out of share views, project link views, download requests, viewer emails and request-inbox uploads. Same rules as the live capture path: the folded address is the identity, a webmail domain is not a company, owner-side rows are not contacts. | Yes: `$min`, `$max`, `$addToSet` and `$setOnInsert` throughout, so a second run changes nothing and a contact live traffic created first keeps what it has | The unique index can fail if two rows already share one address in a workspace, which is the thing it exists to prevent; it is built before the backfill so a failure stops before any write. `CONTACTS_BACKFILL_DRY_RUN=1` counts without writing |
| `20260925_0007_activity_actor_index.mjs` | Creates `activityevents.orgId_1_userId_1_createdDate_-1__id_-1`, the keyset index the new contributor pages (`/people/:userId`, `/agents/:client/:ownerUserId`) page one member's rows with. The existing `orgId_1_userId_1_createdDate_-1` serves the first page and nothing after it, because the feed's `$or` cursor cannot be a single range without `_id` in the key, and the fallback is an in-memory sort of that member's whole history on every page. `src/lib/models/ActivityEvent.ts` declares the same key, so autoIndex leaves it alone; it is a migration because `activityevents` is the busiest collection in the product and an autoIndex build on it fails silently. | Yes: same key and name is left alone, a different key is dropped and rebuilt | No (non-unique). `activityevents` is the largest collection, so this is the slowest of the seven; the runner waits. It does **not** drop the narrower `orgId_1_userId_1_createdDate_-1` it supersedes, on purpose: dropping an index the currently deployed functions still plan against, from a migration that runs before the deploy, turns a performance change into an outage. That drop is by hand after the deploy, in step 3 |

- [ ] The run ends with `All migrations complete.` and the `migrations` collection has 26 rows
      (the nineteen already applied plus these seven).
- [ ] `mongosh` spot check after the run:

```
mongosh "$MONGODB_URI" --quiet --eval '
print(db.orgmemberships.getIndexes().filter(i => ["userId_1","orgId_1"].includes(i.name)).map(i => i.name + (i.partialFilterExpression ? " PARTIAL" : " plain")));
print(db.projects.getIndexes().filter(i => ["orgId_1_name_1","orgId_1_slug_1"].includes(i.name)).map(i => i.name + " " + JSON.stringify(i.partialFilterExpression)));
print(db.airuns.getIndexes().filter(i => i.name === "createdDate_ttl").map(i => "ttl " + i.expireAfterSeconds));
print(db.shareviews.getIndexes().some(i => i.name === "lastViewedAt_-1"), db.sharevisits.getIndexes().some(i => i.name === "lastEventAt_-1"), db.sharelinks.getIndexes().some(i => i.name === "lastViewedAt_-1"), db.activityevents.getIndexes().some(i => i.name === "type_1_createdDate_-1"));
print(db.activityevents.getIndexes().some(i => i.name === "orgId_1_userId_1_createdDate_-1__id_-1"));
print("request repos without isRequest:", db.projects.countDocuments({ requestUploadToken: { $exists: true, $nin: [null, ""] }, isRequest: { $ne: true } }));'
```

Expect `plain` twice, both project filters with `"isDeleted":false`, `ttl 2592000` (30 days),
`true true true true`, `true` for the actor keyset index (migration 0007), and `0`.

## 2. Environment variables

Nothing new is required on any host. What is new, with defaults, by host:

**Vercel, Production** (`DEPLOY.md` 5 step 3 table has the rows):

| Variable | Default when unset | Notes |
|---|---|---|
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | Slack integration off: `/integrations/slack` says "not set up on this deployment", `GET /api/slack/install` answers 503 `SLACK_NOT_CONFIGURED` | Both or neither (`src/lib/slack/config.ts`, `slackAppConfig`). From the Slack app created per DEPLOY.md 4.7; its redirect URL must be exactly `<configured site origin>/api/slack/oauth/callback` (the URL is built from `resolveConfiguredSiteUrl`, never from the request host). `PRODUCTION.md` records these as not set; the feature can ship dark and be turned on with a redeploy |
| `LNKDRP_SLACK_SECRET` | Falls back to `NEXTAUTH_SECRET` (`src/lib/slack/crypto.ts`, HKDF master for the webhook-URL encryption and the install state) | Generate it (`openssl rand -hex 32`, DEPLOY.md 3) before the first channel is connected. Stored webhook URLs are encrypted under a key derived from it, so changing it after channels exist means reconnecting them |
| `AI_RUN_RETENTION_DAYS` | `30` (`src/lib/models/AiRun.ts`) | Positive integer; anything else is the default. Same value the migration used (step 1) |
| `CONTACTS_BACKFILL_DRY_RUN` | unset: migration `20260925_0006` writes | Read by that migration alone, never by the app. `1` counts what it would create and writes nothing. Set it in `prod.env` for a rehearsal, never on Vercel |

Not new on this branch, already on `main`, listed so nobody looks for them: `STRIPE_PRICE_ID_ANNUAL`
(yearly Pro, commit `bb19104`), `ERROR_LOGGING_ENABLED` / `ERROR_LOGGING_MIN_SEVERITY` /
`ERROR_LOGGING_ALLOWED_ENVS`, `BLOB_BASE_URL`. The grep also finds `TEST_REALTIME_URL`
(`scripts/realtime-e2e.ts`, a dev tool), `CHROME_PATH` (`scripts/home-shot-slack.ts`, the script
that composes the homepage Slack shot) and `SCRATCH`, `WHO`, `MAIL` in `scripts/_tmp-*.ts`, four
committed scratch scripts from the data-room drive; none is read by the app.

Re-checked on 2026-09-26 by diffing every `process.env.*` reference under `src`, `realtime`, `mcp`,
`db` and `scripts` between `main` and `fbede1d`: the seven above are the complete set this branch
introduces, and the fifteen commits since this file was written added none.

**Fly, `lnkdrp-realtime`** (`realtime/server.ts`):

| Variable | Default when unset | Notes |
|---|---|---|
| `REALTIME_MONGODB_URI` | Falls back to `MONGODB_URI` | The server now reads its own name first so one env file can hold both credentials. `fly secrets list -a lnkdrp-realtime` today shows whichever name the 2026-09-24 deploy used (`PRODUCTION.md` says the read-only user `lnkdrp_prod_realtime` on `/lnkdrp-prod`; the variable name there was not recorded). Either keeps working; to rename, `fly secrets import` the new name and `fly secrets unset MONGODB_URI` in one deploy |

**Fly, `lnkdrp-mcp`** (`mcp/src/config.ts`, `sessionCaps.ts`, `optimize.ts`):

| Variable | Default when unset | Notes |
|---|---|---|
| `LNKDRP_API_URL` | `https://www.lnkdrp.com` in production | Now in `deploy/fly/mcp.fly.toml` `[env]`. The live machine was deployed from `main` with `--env LNKDRP_API_URL=https://www.lnkdrp.com` because `main`'s toml still says the apex, which 308s to `www` and fails every tool call (`docs/MCP.md`, Status). From this deploy the toml carries it; pass nothing extra |
| `LNKDRP_MCP_MAX_SESSIONS_PER_KEY` | `20` | Live sessions one credential (key or OAuth grant) may hold; at the cap its stalest session is closed (review M17). Leave unset |
| `LNKDRP_MCP_MAX_SESSIONS` | `500` | Process-wide cap; `initialize` past it answers JSON-RPC 429. Leave unset. Both are printed at startup and on `/healthz` as `sessionCaps` |
| `LNKDRP_PDF_OPTIMIZE_CONCURRENCY` | `2` | Ghostscript plus pdfjs runs at once; the rest queue (`mcp/src/semaphore.ts`, M16). Leave unset on the 512 MB machine |
| `MCP_CORS_ORIGINS` | unset: no cross-origin browser access to `/mcp` | Comma-separated exact origins, never `*`. Server-side clients do not need it. Leave unset |
| `REALTIME_SECRET` | unset: the server polls (`realtime: 'off (polling only)'` at startup) | Unchanged, and currently unset on the live machine (`docs/MCP.md`). DEPLOY.md 7 has the trade-off; polling is acceptable |
| `LNKDRP_ALLOW_LOCAL_FILES`, `LNKDRP_SKIP_CONFIRMATIONS`, `LNKDRP_API_KEY` | unset | Never on the hosted server (DEPLOY.md 7) |

- [ ] Vercel: add the Slack rows (or deliberately leave them out) and `AI_RUN_RETENTION_DAYS` if
      not 30. Any change needs a redeploy to take effect.
- [ ] Preflight: `/a/env` (or `npm run preflight:env`) now has `SLACK_CLIENT_ID` and
      `SLACK_CLIENT_SECRET` as wanted rows under Secrets (`src/lib/preflight/env.ts`); a warning
      there is expected when Slack is off. The Mongo row no longer fails on a multi-host URI.

## 3. Indexes

**Built by the migration runner (step 1)**: sixteen, counted from the migration files. Two on
`orgmemberships` (0001, dropped and rebuilt plain); four from 0002 (`shareviews.lastViewedAt_-1`,
`sharevisits.lastEventAt_-1`, `sharelinks.lastViewedAt_-1`, `activityevents.type_1_createdDate_-1`);
the two `projects` unique indexes (0003); the `airuns` TTL (0004); six on `contacts` (0006:
`orgId_1_email_1` unique, then `orgId_1_lastSeenAt_-1`, `orgId_1_domain_1`, `orgId_1_docIds_1`,
`orgId_1_projectIds_1`, `orgId_1_name_1`); and `activityevents.orgId_1_userId_1_createdDate_-1__id_-1`
(0007). 0005 builds none. The spot check above names ten of the sixteen; the six `contacts` indexes
are covered by 0006 failing loudly if the unique one cannot build. Nothing else needs the runner.

**Built by Mongoose `autoIndex` on the first function that imports the model after the deploy**
(DEPLOY.md 5.4 explains that a failure here is silent). New collections, all empty at deploy, so
nothing can conflict:

| Collection (model) | Indexes |
|---|---|
| `oauthclients` (`OAuthClient.ts`) | `clientId_1` unique |
| `oauthcodes` (`OAuthCode.ts`) | `codeHash_1` unique, `clientId_1`, `expiresAt_1` TTL 24 hours (`expireAfterSeconds: 86400`) |
| `oauthgrants` (`OAuthGrant.ts`) | `orgId_1`, `clientId_1`, `accessTokenHash_1` unique, `refreshTokenHash_1` unique, `isDeleted_1`, `orgId_1_createdDate_-1`, `orgId_1_revokedAt_1_isDeleted_1` |
| `slackconnections` (`SlackConnection.ts`) | `orgId_1`, `status_1`, `orgId_1_channelId_1` unique |
| `slackoutbox` (`SlackOutbox.ts`) | `orgId_1`, `connectionId_1`, `dedupeKey_1` unique, `status_1_nextAttemptAt_1_occurredAt_1`, `connectionId_1_sentAt_-1`, `sentAt_1` TTL 30 days partial on `status: "sent"` |

On existing collections, autoIndex adds one index the migrations do not: `docs.visibility_1`
(`src/lib/models/Doc.ts`, the new `visibility` field, non-unique). It builds on the whole `docs`
collection from a function cold start. DEPLOY.md 9 asks for large-collection indexes to go through a
migration; this one did not, so if `docs` is large enough to care, create it by hand right after
step 1 and autoIndex will find it in place:

```
mongosh "$MONGODB_URI" --quiet --eval 'db.docs.createIndex({ visibility: 1 }, { name: "visibility_1" })'
```

The four indexes the models share with migration 0002, the `airuns` TTL and the two `projects`
unique indexes are also declared in the models; because the migration built them first with the
same key, name and options, autoIndex leaves them alone.

`oauthcodes.expiresAt_1` is the 24-hour TTL index (`expireAfterSeconds: 86400`), the only declaration
on the field since `7f98f91` (`oauthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 })`).

- [ ] Run the DEPLOY.md 5.4 index check after step 1 and again after the first traffic. Its `want`
      list predates this release; add these rows to it before running (the same shape):

```
  oauthclients: ["clientId_1"],
  oauthcodes: ["codeHash_1"],
  oauthgrants: ["accessTokenHash_1", "refreshTokenHash_1"],
  slackconnections: ["orgId_1_channelId_1"],
  slackoutbox: ["dedupeKey_1", "status_1_nextAttemptAt_1_occurredAt_1"],
  airuns: ["createdDate_ttl"],
  activityevents: ["type_1_createdDate_-1", "orgId_1_userId_1_createdDate_-1__id_-1"],
  sharelinks: ["shareId_1", "sharelinks_label_audience_text", "lastViewedAt_-1"],
  shareviews: ["shareId_1_botIdHash_1", "docId_1_lastViewedAt_-1", "shareId_1_lastViewedAt_-1", "lastViewedAt_-1"],
  sharevisits: ["shareId_1_botIdHash_1_visitIdHash_1", "lastEventAt_-1"],
  projects: ["shareId_1", "orgId_1_name_1", "orgId_1_slug_1"],
  orgmemberships: ["orgId_1_userId_1", "userId_1", "orgId_1"],
```

`NO COLLECTION` for the five new collections is fine until someone signs an agent in or connects
Slack.

**Two indexes come off by hand, after the deploy, in this order.** `autoIndex` creates and never
drops, so each narrower index stays beside the wider one that supersedes it and every
`activityevents` write pays for both. DEPLOY.md 5.4 carries the same instruction:

```
mongosh "$MONGODB_URI" --quiet --eval '
db.activityevents.dropIndex("orgId_1_createdDate_-1");
db.activityevents.dropIndex("orgId_1_userId_1_createdDate_-1");'
```

`orgId_1_createdDate_-1` is a prefix of `orgId_1_createdDate_-1__id_-1`; the contributor pages added
the same pair one equality deeper, so `orgId_1_userId_1_createdDate_-1` is now a prefix of
`orgId_1_userId_1_createdDate_-1__id_-1` (migration `20260925_0007`). Drop them **after** the web
app is on the new build, never before: the deployed functions plan against them until then.

## 4. Stripe

- [ ] **Webhook events: no change.** The endpoint still needs exactly the seven of DEPLOY.md 4.2
      step 4 (`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
      `customer.subscription.created`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`);
      `src/app/api/stripe/webhook/route.ts` handles those and ignores the rest. Nothing to add in
      the Stripe dashboard. Two behaviour changes inside the handler: on a subscription whose
      licensed item is yearly it nulls `stripeSubscriptionItemId` and turns on-demand off
      (`disableOnDemandForSubscription`, reason `subscription.yearly`), and `POST /api/stripe/checkout`
      now records a `checkout.started` activity row before returning the Checkout URL.
- [ ] **Pro price label fallback.** `getBillingProPriceLabel` (`src/lib/billing/proPriceLabel.ts`)
      reads the labels from Stripe (`src/lib/billing/proPriceFromStripe.ts`, `STRIPE_PRICE_ID` and
      `STRIPE_PRICE_ID_ANNUAL`) when `billingconfigs` has no monthly label, writes them to the row,
      and caches an hour under the tag `billing:pro-price-label` (cache key `v3`). So a deployment
      whose admin never pressed Refresh still prints `$29/mo` on `/pricing`; "price shown at
      checkout" now means Stripe itself could not be read. The admin refresh (`/a/tools/billing`,
      `POST /api/admin/billing/pro-price`) is unchanged and still the way to pick up a changed price
      id inside the hour; it answers 400 for an annual id that is not a yearly licensed price.
      After the deploy open `/pricing` signed out: `$29/mo` must show without any admin action, and
      the Monthly / Yearly toggle only if `STRIPE_PRICE_ID_ANNUAL` is set in production (not
      confirmed from the repo; DEPLOY.md 4.2 step 7).
- [ ] Deletion now touches Stripe (`src/lib/billing/stripeSubscriptionCancel.ts`):
      `DELETE /api/orgs/:orgId` cancels the workspace's subscription immediately (prorated on
      yearly) before deleting and answers 502 `STRIPE_CANCEL_FAILED` and deletes nothing if Stripe
      fails; `POST /api/account/delete` sets `cancel_at_period_end` on subscriptions nobody else
      could manage and refuses the whole request with the same 502 on failure. The live
      `STRIPE_SECRET_KEY` must therefore be able to cancel subscriptions (a restricted key that can
      only create Checkout sessions would now block deletions).

## 5. Deploy the web app

- [ ] The push to `main` deploys. `vercel.json` is unchanged (still twelve cron entries, no new
      job), so Settings, Cron Jobs needs no attention beyond confirming the list is intact.
- [ ] If any env row changed in step 2, Redeploy afterwards (env is read at build for
      `NEXT_PUBLIC_*` and at runtime for the rest; a redeploy covers both).
- [ ] `curl -s https://www.lnkdrp.com/api/health` shows `version` equal to the merge SHA
      (`git rev-parse --short=7`).

## 6. Redeploy both Fly services (after the web app)

Both changed and neither auto-deploys (DEPLOY.md 9). Deploy the web app first: the MCP's OAuth path
and four of its tools call routes that only exist on the new build
(`/.well-known/oauth-authorization-server`, `/api/oauth/*`, `GET /api/changes`,
`PATCH /api/docs/:id { visibility }`, `POST /api/docs { projectId }`, `credentialId` on
`/api/agent/whoami`). The Dockerfile pins (mongoose 8.20.3, ws 8.21.3, sdk 1.30.0, express 5.2.1,
zod 4.2.0, tsx 4.21.0, `node:22.23.2-alpine`) still equal what `package-lock.json` resolves; the
lockfile diff on this branch is flag-only. `src/lib/limits/uploads.ts`, `src/lib/credits/schedule.ts`
and `mcp/Dockerfile` are unchanged.

**Realtime** (`realtime/server.ts`: `REALTIME_MONGODB_URI`, and the `projects` change stream is now
projected to `_id`, `orgId`, `name` so request-repo capability tokens stop travelling to that host,
review M20; `realtime/Dockerfile` comment only). From the clean checkout, DEPLOY.md 6.2:

```
fly deploy --ha=false --strategy bluegreen --config deploy/fly/realtime.fly.toml --dockerfile realtime/Dockerfile \
  --image-label "$(git rev-parse --short=7 HEAD)"
fly scale show -a lnkdrp-realtime            # one machine
fly logs -a lnkdrp-realtime --no-tail         # `mongo connected`, no `[realtime] fatal`
```

**MCP** (everything under `mcp/src/`: OAuth resource metadata, session binding to the grant id,
session caps, inline limits and body guard, semaphore, the confirmation policy, CORS allow-list,
four new tools, `share_pdf { projectId | projectSlug }`, per-credential idempotency; and
`deploy/fly/mcp.fly.toml` `[env]`). DEPLOY.md 7:

```
fly deploy --ha=false --config deploy/fly/mcp.fly.toml --dockerfile mcp/Dockerfile \
  --image-label "$(git rev-parse --short=7 HEAD)"
fly scale show -a lnkdrp-mcp                  # exactly one machine
fly logs -a lnkdrp-mcp --no-tail              # `listening on :8787`, `cors: off (no browser origins)`, `sessionCaps: 20 per credential, 500 total`
```

- [ ] Deploy the MCP outside busy hours: the single machine restarts and every live MCP session is
      dropped (`404 Session not found`; clients reconnect). Clients also cache the tool list, so an
      agent connected before the deploy does not see the four new tools until it reconnects
      (DEPLOY.md 7, "Redeploy the MCP whenever its tool list changes").
- [ ] The dev twins (`dev-lnkdrp-realtime`, `dev-lnkdrp-mcp`, `deploy/fly/dev-*.fly.toml`,
      `COMMANDS.md`) are optional and not part of production.

## 7. Smoke tests, in order

Each line is the request and the answer that means it worked. `$KEY` is an `lnk_` key from
`/connect`; `$CRON_SECRET` as in DEPLOY.md 3.

1. `curl -s https://www.lnkdrp.com/api/health` → `"ok":true`, `"mongo":"ok"`, `"version"` = the
   merge SHA.
2. `curl -sI 'https://www.lnkdrp.com/preferences?tab=spending' | grep -i location` →
   `location: /dashboard?tab=billing`. Then `curl -sI https://www.lnkdrp.com/preferences/usage`
   → `location: /dashboard?tab=usage`. (`src/app/preferences/page.tsx`, `[tab]/page.tsx`,
   `tabs.ts`: the old page is gone and both routes redirect.)
3. `curl -s https://www.lnkdrp.com/.well-known/oauth-authorization-server` → JSON with
   `"issuer":"https://www.lnkdrp.com"`, `authorization_endpoint` ending `/connect/authorize`,
   `token_endpoint` ending `/api/oauth/token`, `registration_endpoint` ending `/api/oauth/register`,
   `code_challenge_methods_supported: ["S256"]`, and `access-control-allow-origin: *` in the
   headers.
4. `curl -s https://mcp.lnkdrp.com/healthz` → `{ ok: true, sessions, sessionCaps: { perCredential: 20,
   total: 500 }, version: "0.1.0", apiUrl: "https://www.lnkdrp.com", confirmations: "enforced" }`.
   `confirmations` must read `enforced`; `apiUrl` must be the `www` host.
5. `curl -s https://mcp.lnkdrp.com/.well-known/oauth-protected-resource` →
   `authorization_servers: ["https://www.lnkdrp.com"]`, `scopes_supported: ["read","write"]`.
   (On `main`'s image this array was empty.)
6. `curl -s https://realtime.lnkdrp.com/healthz` → `"ok":true`, all seven `streams` true
   (`activity`, `apikeys`, `docs`, `projects`, `uploads`, `shareviews`, `projectlinkviews`).
7. **Sign an agent in.** `claude mcp add --transport http lnkdrp https://mcp.lnkdrp.com/mcp`
   (no key), then `/mcp` in Claude Code and sign in: the browser opens
   `https://www.lnkdrp.com/connect/authorize?...`, shows the workspace picker and Allow, and the
   client reports connected. On `/connect` the agent is listed under Keys and agents as
   "Signed in" with a Revoke button. Ask it for `lnkdrp_whoami`: the answer carries
   `credentialKind: "oauth"`, `keyPrefix: "signed in"`, and `integrations.slack.connected: false`.
   This is the first live run of the OAuth path (`docs/prds/lnkdrp-mcp-oauth.md`, "untested against
   a real client until mcp.lnkdrp.com is up"), so if it fails here, keys still work and nothing
   else depends on it.
8. `curl -s -H "Authorization: Bearer $KEY" https://www.lnkdrp.com/api/agent/whoami` →
   `credentialId` (the key id), `credentialKind: "key"`, `integrations: { slack: { connected: false,
   channels: [] } }`.
9. `curl -s -H "Authorization: Bearer $KEY" 'https://www.lnkdrp.com/api/changes?since=7d&contributors=1'`
   → `{ since: <ISO>, nextCursor, items: [...], contributors: [...], agents: [...] }`, 200 even
   when empty (`src/app/api/changes/route.ts`). A read-only key gets the same answer;
   `GET /api/docs/:id/changes?version=2` answers the single compare.
10. From the agent, `lnkdrp_list_revisions { since: "7d" }`, `lnkdrp_get_revision` on a document
    with a second version, and `lnkdrp_set_doc_visibility` on a document in no project: the last
    answers `validation` with `details.code: "VISIBILITY_NEEDS_PROJECT"`. Listing tools shows 39,
    the 37 of the first draft plus `lnkdrp_list_contacts` and `lnkdrp_get_contact`
    (`docs/MCP.md`, and `EXPECTED_TOOLS` in `tests/mcp/e2e.ts`).
11. Destructive confirmation: ask the agent to delete a share link. In Claude Code the first call
    is refused with `details.requiresConfirmation: true`, the preview, and either
    `details.elicitationFailed: true` or `details.userAction: "cancel"`; the agent relays the
    preview; the follow-up with `confirm: true` inside ten minutes goes through
    (`mcp/src/confirm.ts`). A `confirm: true` on the first call is not honoured.
12. Inline limit: `lnkdrp_share_pdf` with a `fileBase64` over 16 MB → `too_large` naming 16 MB and
    pointing at `sourceUrl`, before anything is created. A 5 MB deck that optimises to under 3 MB
    uploads with `optimized` set.
13. Contained documents: upload a PDF into a data room from `/upload?project=<id>` ("Add to a data
    room" preselected) with "Only inside this data room" ticked. The document is absent from the
    Docs sidebar, `/api/docs`, search and `lnkdrp_list_docs`, present in the project's list and
    `lnkdrp_get_project`, its share link opens, and its page shows the Contained pill. The feed
    shows one "... in <room>" creation row and no "added to project" row.
14. Free view email: on a Free workspace with view emails on Immediately, open a share link in a
    private window; within five minutes the email's primary button goes to
    `/doc/<id>/metrics?shareId=<shareId>` and the secondary "See who opened it" to
    `/pricing?from=view_email` (`src/lib/notifications/viewNotifications.ts`). No link to the
    reader page on Free. On that document's `/doc/<id>/metrics` the blurred rows are gone:
    "N named people and M anonymous readers opened this since <date>" with one Upgrade to Pro
    button.
15. `/pricing` signed out → `$29/mo` printed (step 4 above). `/credits` on a Free workspace → the
    cheapest pack first; the out-of-credits modal on Free offers the pack before Pro.
16. Admin: `/a/funnel` renders the weekly table (zeros are fine); `GET /api/admin/funnel?weeks=8`
    as the admin → `{ weeks: [...] }`. `/a/shareviews/<docId>` loads and has "Load older views".
    `curl -s https://www.lnkdrp.com/api/debug` signed out → 404 (admin only now;
    `GET /api/debug/cookie` the same).
17. Cron dry run no longer overwrites health: note `lastRunAt` on `/a/cron-health` for
    `plan-limits`, run
    `curl -X POST 'https://www.lnkdrp.com/api/cron/plan-limits?dryRun=1' -H "Authorization: Bearer $CRON_SECRET"`
    → 200, and `lastRunAt` is unchanged (`src/lib/cron/health.ts`). Then
    `curl -X POST 'https://www.lnkdrp.com/api/cron/analytics-reconcile?dryRun=1' -H "Authorization: Bearer $CRON_SECRET"`
    → 200; the next real run's `lastParams.since` is two days back; `?full=1` recomputes every
    link (`docs/CRON.md`).
18. Slack, only if step 2 set the two credentials: `/integrations` lists Slack with "Set up" (no
    flash of the wrong state on reload); `/integrations/slack`, Add to Slack, pick a channel, Send a
    test message arrives. Then open a share link: an "opened" post arrives in the channel naming
    "Someone" on Free or the reader on Pro. Without the credentials the page says Slack is not set
    up and `GET /api/slack/install` (signed in as an owner) is 503.
19. **Contributor pages** (new since this file was first written). On `/activity`, click the bold
    subject name on a row: a row a person did opens `/people/<userId>`, a row an agent did opens
    `/agents/<client>/<ownerUserId>` even when the sentence prints the member's name, and the link's
    tooltip says so. A row credited to both ("Ana Lima and Claude Code") is two links, one to each.
    The page shows the all-time tiles, the by-day work chart and the feed underneath, and an agent's
    "Connected by" line lands on that person's page with its own loading state rather than leaving
    the agent's name on screen. `GET /api/activity/actor?key=person:<userId>` answers the profile
    and 404 for a key with no activity in the active workspace;
    `GET /api/activity?actor=<key>` and `GET /api/activity/summary?actor=<key>` take the same key.
    A hand-typed or truncated key shows the not-found UI (streamed, so HTTP 200). On Free the
    identity gate blanks the key and the link along with the name.
20. **Contacts CSV.** On a workspace under the cap, `/contacts` → Download CSV writes the file and
    it opens in Excel with accented names intact (a UTF-8 BOM leads it). Past
    `CONTACTS_CSV_MAX_ROWS` (25,000, `src/lib/contacts/csv.ts`) the button reads "Too many to
    download" and `GET /api/contacts/export` answers 413 with the count, before the first byte.
21. **Slack is gated by scale, not as a feature** (only if step 2 set the two credentials). On Free,
    `/integrations/slack` shows a Pro pill on **Add channel** and on the routing picker; the first
    channel connects and posts all five kinds. A second install run past the cap stores nothing and
    returns to the page as `reason=plan_limit` (the check is in the OAuth callback, not at the
    button, because Slack's own screen is reachable from a stale tab). Reconnecting a channel the
    workspace already has is an update and is always allowed. `PATCH /api/orgs/active/slack` with a
    non-empty `projectIds` on Free answers 402; with an empty one it succeeds, so a workspace that
    drops to Free can undo its own routing. A post arrives **once**, not twice, and carries a
    coloured left bar: accent green for what a recipient did, grey for what the workspace did.
22. Index check (step 3) once more, including the two hand-drops; then DEPLOY.md 9's post-deploy
    list (`/api/monitor/crons` 200, a view on `/activity` within a second).

## 8. Rollback notes

- **Web app**: Vercel Instant Rollback to the previous production deployment (DEPLOY.md 10). The
  old build runs against the migrated database; every change in this release is additive or
  index-only from the old code's point of view (`visibility` defaults to `workspace`, `isRequest`
  and `isDeleted: false` were values the old code already wrote, the new collections are ignored),
  so a code rollback needs no database action. Two things do not roll back with the code: AI runs
  already swept by the TTL (gone), and the old `projects` unique indexes (the old build keeps
  working with the live-only filter; it merely allows a name a deleted project once held).
  `/preferences` on the old build is the old page again; nothing links to it either way.
- **Migrations**: no down steps. `20260925_0001`, `0002`, `0003` and `0005` are harmless to leave in
  place under the old code. `0004` is the one to think about before running: lower retention is
  irreversible for the rows it removes. To stop further expiry without restoring,
  `db.airuns.dropIndex("createdDate_ttl")` (the old model does not declare it, so autoIndex will not
  recreate it; the new one will on its next cold start).
- **Fly services**: redeploy the previous image by label, never by rebuilding
  (`fly releases --image -a lnkdrp-mcp`, then `fly deploy --ha=false -a lnkdrp-mcp --config
  deploy/fly/mcp.fly.toml --image registry.fly.io/lnkdrp-mcp:<label>`; same for
  `lnkdrp-realtime`). The previous MCP image was deployed with
  `--env LNKDRP_API_URL=https://www.lnkdrp.com` (`docs/MCP.md`); a rollback of the image with the
  new toml keeps that value from `[env]`, so nothing to pass. An old MCP image against the new web
  app works (keys, the 33 tools); OAuth sign-in stops (its resource metadata names no
  authorization server) and grants already issued keep working on the REST side.
- **OAuth grants and Slack connections** issued during the release survive a rollback as rows and
  become live again on roll-forward. To cut them off while rolled back: the old build lists keys
  only, so `db.oauthgrants.updateMany({}, { $set: { revokedAt: new Date() } })`; Slack posts simply
  stop because the old build has no outbox.
- **Stripe**: nothing to undo; no catalog or webhook change in this release.
- **Kill switches** (DEPLOY.md 10): MCP `fly scale count 0 -a lnkdrp-mcp`; realtime
  `REALTIME_DISABLED=1` and redeploy; Slack: unsetting `SLACK_CLIENT_ID` and redeploying stops new
  installs, and `db.slackconnections.updateMany({}, { $set: { status: "revoked" } })` stops posting
  from existing channels.

## Not confirmed from the repo

- Whether production has `STRIPE_PRICE_ID_ANNUAL` set (decides the yearly toggle on `/pricing`).
- The variable name the 2026-09-24 realtime deploy used for its Mongo URI on Fly.
- The size of `docs` in production, which decides whether `visibility_1` should be built by hand.
- Whether a Slack app exists at api.slack.com (`PRODUCTION.md` says the credentials are not set).
- The OAuth flow against a real client has not been run before this deploy (PRD implementation note).
- ~~After these two files are committed, `npm run index` must be run so `INDEX.md` lists them.~~
  Wrong, and settled on 2026-09-26: both files were committed in `4c24fba`, and `INDEX.md` does not
  track `docs/deploy/**` or `docs/releases/**` at all (it carries `docs/DEV.md` and
  `docs/FEATURES.md` only). `tests/lib/indexMap.test.ts` does not fail on them. It **is** failing in
  the working tree right now, for an unrelated reason: see "Known red at time of writing".

## Known red at time of writing

Found on 2026-09-26 while reconciling this file against `fbede1d`. Everything here is **working
tree only unless it says otherwise**: the release commit itself was built and typechecked for this
pass and is green. The tree is carrying another session's in-flight refactor, so a gate run in this
checkout is not a gate run on the release.

**The release commit is green.** In a throwaway worktree at `fbede1d` with `node_modules` junctioned
in and `.env.local` copied, `npx next build --webpack` exits 0 ("Compiled successfully in 26.9s",
TypeScript clean, 121 static pages, `/people/[userId]` and `/agents/[client]/[ownerUserId]` both in
the route table) and `npx tsc --noEmit -p .` reports zero errors. Webpack rather than Turbopack only
because Turbopack cannot follow a directory junction; the deploy itself builds on Vercel with the
project's normal bundler, so this proves the code compiles, not that the Vercel build is byte-for-byte
the same. The `Dynamic server usage` lines in the log are Next falling back to dynamic rendering on
routes that read `headers`, which is expected and does not fail the build.

**Red in the working tree, not in the release:**

- `npx tsc --noEmit -p .` in this checkout reports **13 errors, all in
  `tests/lib/actorProfile.test.ts`** (TS2345, lines 99 to 290). The test is committed and unmodified;
  the cause is that **`src/lib/people/profile.ts` is modified and uncommitted** by the other session,
  which added a required `viewerUserId` to `loadActorProfile`'s argument without updating the test.
  Not fixed here, deliberately: the code is not this pass's to touch. It blocks the step 0 gate
  **in this checkout only**. A clean checkout of `fbede1d` has zero errors.
- `tests/lib/indexMap.test.ts` fails with "INDEX.md is out of date. Run `npm run index`". The only
  drift it names is `mcp/src/tools/whoami.ts` gaining an exported `AdvertisedCost`, which exists in
  the working tree and **is not committed**. `INDEX.md` itself is clean and matches `fbede1d`. Not
  fixed here: `npm run index` and `INDEX.md` were out of scope for this pass, and running it now
  would commit the other session's symbol into the index.
- `db/migration/20260925_0007_projects_locked_indexes.mjs` is **untracked** and collides on the
  ordinal with the committed `20260925_0007_activity_actor_index.mjs`. It belongs to the other
  session's locked-projects work. It does not ship, because the deploy runs from a clean checkout
  of the merge SHA, and `run.mjs` sorts by filename, so it would sort second if it ever did.
  **The risk is running migrations from a dirty checkout**: step 1 says clean checkout for exactly
  this reason, and this is what it protects against. Whoever lands the locked-projects branch should
  renumber theirs to `0008`, because two files sharing an ordinal make the `migrations` rows
  impossible to read back.

**Shipped but inert, worth knowing before someone reports it as a bug:**

- `fbede1d` ("Slack: a hierarchy in the channel, and a lock that routing honours") includes
  `src/lib/slack/outbox.ts` querying `ProjectModel.find({ ..., visibility: "locked" })`, but
  `src/lib/models/Project.ts` **at `fbede1d` has no `visibility` field**. It exists only in the
  other session's uncommitted edit to that model. So on the release commit that query matches
  nothing, `locked` is always empty, and routing falls through to the previous behaviour. It is
  fail-safe (no row can be locked without the rest of that feature, so there is nothing to leak) and
  it typechecks, because a Mongoose filter accepts a field the schema does not declare. But the
  commit message's claim that a locked room no longer falls through to the catch-all channel is
  **not true of this release**; it becomes true when the locked-projects work lands. Do not
  cherry-pick that guarantee into the release notes.

**Not red, but unverified and staying that way:** the two Fly deploys, the OAuth flow against a real
client, and every smoke test in step 7 need the deploy to have happened. Nothing above was run
against production.
