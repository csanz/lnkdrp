# Admin coverage

What `/a` can tell an operator at 3am, and what it cannot.

The admin area is in better shape than this document's length suggests. Sixteen sections exist,
every one of the forty-one `/api/admin/*` routes is gated by `requireAdmin`, the redaction rules are
deliberate and written down, and the workspace hub answers almost every support question about a
workspace you can already name. The gaps are not carelessness. They are all the same shape: a
question you ask about the *deployment* rather than about a row in it.

Read sections 3 and 5 if you skip the rest. Section 3 is the half that is actively misleading;
section 5 is the ranking.

Line references were correct on 2026-09-20. Search by symbol.

---

## 1. What is there

| Section | The figures it actually shows | Endpoint |
|---|---|---|
| `/a` home | Views, new documents, signups, AI runs over 7/30/90d, each selectable as the chart series; then standing totals (workspaces, accounts, live documents, enabled links); then MRR, ending MRR, charged in window, pack count; then failing jobs and pending deletions | `/api/admin/overview`, `/api/admin/revenue` |
| `waitlist` | Queued accounts oldest first, approved accounts with an `approvedAt` on record, with search and approve | `/api/admin/waitlist`, `…/[userId]/approve` |
| `shareviews` | Viewers, documents touched, views in 24h, downloads, a daily series, a pages-seen distribution, and a top-documents table, all derived client side from the 200 most recently updated rows | `/api/admin/shareviews/recent?limit=200`, `…/doc/[docId]` |
| `ai-runs` | Paged run log: kind, status, provider, model, temperature, `maxTokens`, duration, prompt sizes in characters, and the correlation ids. No token usage, no cost | `/api/admin/ai-runs`, `…/[runId]` |
| `credits` | Fleet balances (starter / included / purchased, caps, on-demand policy, ordered by who runs out first), an anomaly sweep with per-pass scan counts, a ledger tail, purchases and on-demand by workspace, a per-workspace snapshot, plus grant and cycle-simulation actions | six routes under `/api/admin/credits/` |
| `cron-health` | One row per job from the registry (not from the heartbeats), state against its own schedule, last run, duration, error, plus the notification queue depth on the `notification-emails` row | `/api/admin/cron-health` |
| `deletions` | Who asked to delete, when, why, and whether the purge has run | `/api/admin/deletions` |
| `emails` | The catalog of every email the product can send and what trace each leaves; the notification queue's live depth (pending, due, sending, sent 24h, skipped, dead) and up to 50 dead letters; the last run of `notification-emails` and `plan-limits` summarised; rendered previews of every template from the real builders; and the download-request table with per-message send outcomes | `/api/admin/emails/{overview,previews,download-requests}` |
| `data/{docs,links,projects,requests,uploads,users,workspaces}` | Paged listings with search, each redacted to withhold share slugs, each with a detail page; workspaces additionally get the hub (plan, Stripe state, balance, ledger tail, API keys, content totals, plan-limit grace, activity tail) | `/api/admin/data/*` |
| `tools/billing` | One stored value, the Pro price label, and the button that refetches it from Stripe | `/api/admin/billing/pro-price` |
| `tools/cache` | This browser's localStorage, and buttons that clear it | none |

Two things worth stating plainly about that table.

**`tools/cache` is not an operations tool.** It clears the localStorage of the browser the admin is
sitting in front of. It is honest about this in its own docstring. It is still one of the two things
filed under Tools, where an operator will look for a lever that touches the deployment.

**The emails page is the best page in the area** and is the model the rest should copy: it separates
what the last run *did* from what is still *owed*, it says so in the copy, and it renders null as
"we could not read this" rather than as zero.

---

## 2. Collected, and not reachable from `/a`

### The error log, which is built and switched off

`src/lib/errors/` is a complete, careful error-logging library. `logErrorEvent` redacts a list of
sensitive keys, bounds message and stack length, fingerprints for grouping, and writes `ErrorEvent`
with indexes on `fingerprint`, `category`, `code` and `workspaceId`. Ten cron routes, the Stripe
webhook, `src/lib/http/errorResponse.ts` and the share-password route all call it.

`GET /api/admin/errors` is finished: env, severity, category, code, `requestId`, `fingerprint` and
`workspaceId` filters, a forced 24h window when no filter is given, a 30-day ceiling, and proper
cursor pagination over `{createdAt, _id}`.

**There is no `src/app/a/errors`.** The endpoint has no page and no sidebar row. Forty-one admin
routes, and the one that answers "what is failing right now" is the only one with no UI.

It is worse than a missing page. `readConfig` in `src/lib/errors/logger.ts` computes
`enabledSafe = (isProdLike ? Boolean(enabledRaw) : enabled) && envAllowed`, so in production the
collection is empty unless `ERROR_LOGGING_ENABLED=true` is set. `DEPLOY.md:611` says so; the
variable is absent from `.env.example`. So the likely state of production today is: a library that
runs, a route that works, a collection with nothing in it, and no screen that would reveal any of
the three.

### AI cost, which is not collected at all

This is the one place where the answer is not "build a page".

`AiRun` records `model`, `provider`, `temperature`, `maxTokens` and `durationMs`. `maxTokens` is the
request ceiling, not usage. There is no token count and no cost on the run.

`CreditLedger` has the fields: `provider`, `promptTokens`, `completionTokens`, `totalTokens`,
`costUnitsActual`, `costUsdActual`. Two problems.

- **`costUsdActual` is never written.** `src/app/api/billing/summary/route.ts:164` says it outright,
  having been burned by it: the aggregate was `$inc`'d by zero forever and the billing header read
  $0.00 for a cycle Stripe had really metered.
- **Token telemetry covers one of six charge sites.** `analysisTelemetry` is passed to
  `markLedgerCharged` only on the summary path in `uploads/[uploadId]/process/route.ts`. The compare
  path (two call sites), the two review paths, the history charge and
  `docs/[docId]/changes/[changeId]/rerun` all charge with no telemetry argument.

So "what did OpenAI cost us last month" cannot be answered from this database at any price, and a
page that summed `totalTokens` would produce a number that is wrong by an unknown amount and looks
right. Fix the write path before anyone builds the page.

The proxy that *does* exist is credits: `/api/admin/credits/purchases` already groups on-demand
credits by workspace over a rolling window. That answers "which workspace is burning *paid* credits".
A Free workspace chewing through its granted balance costs real money and appears nowhere.

### Blob storage totals

`Upload.sizeBytes` is stored. `/api/admin/data/uploads` does not select it, so no admin surface adds
it up. There is no total stored, no per-workspace total, and nothing that would show a single
workspace's footprint. The plan-limit machinery counts documents, not bytes
(see `free-cap-counts-documents`), so nothing else covers this either.

One aggregation over `uploads` grouped by `orgId`, summing `sizeBytes`. The data is already there.

### Realtime

`realtime/server.ts` serves `/healthz` with exactly the facts an operator wants: `ok`, `mongo`,
`draining`, per-stream `streams` health, `rooms`, and total `sockets`. Nothing in `/a` reads it.
Whether realtime is up, and how many sockets it is holding, is answerable only by curling a Fly
host by hand.

Same for MCP: `mcp.lnkdrp.com` has no admin representation at all.

### Rate limiting

`RateLimit` is Mongo-backed precisely so it works across lambdas, and `RateLimitModel` is read by
`src/lib/http/rateLimit.ts` and nowhere else. When the unlock endpoint's three buckets start
refusing people, or when `guardApiKeyRequest` starts charging an agent 300-per-minute, no page says
so. The rows exist and are keyed usefully.

### Document reports

`POST /api/docs/[docId]/report` writes `DocReport`. `grep DocReportModel` returns the writer and the
model file. Nothing reads it, ever. A user-facing "report a problem" that goes into a hole is
SECURITY.md §7 bug 5 in a new place.

### Notification queue: actually fine

The task brief guessed this was a gap. It is not. `readNotificationQueueSummary` and
`readDeadNotifications` in `src/lib/admin/notificationQueueAdmin.ts` surface depth, due, sending,
sent-24h, skipped, dead, oldest-pending and up to 50 dead letters with attempts and last error, on
both `/a/emails` and `/a/cron-health`, deliberately from one implementation so the two cannot drift.
What is missing is only the verb: a dead row stays dead until someone opens a Mongo shell. The PRD's
open question 1 already proposes the retry.

---

## 3. Shown, and wrong

### "Views" on the admin home is not views

`/api/admin/overview` computes the headline Views tile as
`ShareViewModel.countDocuments({createdDate: {$gte: since}, isOwnerPreview: {$ne: true}})`, and the
home page labels it "Recipient opens".

A `ShareView` row is unique on `{shareId, botIdHash}` and upserted. It is one *reader per link*, for
their lifetime. So the tile:

- **undercounts opens**, badly. A reader who opens a deck forty times over a month is one row, and
  contributes nothing in any later window.
- **double-counts people**, because multi-links means the same reader on two links of one document is
  two rows.
- **is a cohort count wearing a traffic count's label.** What it truly measures is "new unique
  readers who first arrived in this window".

The product already has the right collection. `ShareVisit` is the per-tab session row, used by every
owner-facing analytics route (`docs/[docId]/shareviews/visits`, the project equivalents,
`src/lib/analytics/loadReading.ts`, `src/lib/analytics/workspace/query.ts`). No admin route touches
it. The staff number and the customer's own number therefore cannot agree, and the staff one is
lower.

The same object is the chart's `views` series, so the shape is wrong too.

### The home page's cron verdict disagrees with the cron page

There are three implementations of "is this job healthy".

1. `judgeCronHealth` in `src/lib/cron/jobs.ts`. Pure, tested in `tests/lib/cronHealth.test.ts`,
   knows `ok | error | late | stuck | never-run`, judged against each job's own `intervalMs`. Used by
   `/api/monitor/crons`.
2. `buildCronRows` in `src/lib/admin/cronSchedule.ts`. A second judgment with a fourth vocabulary
   (`running`, and `never` rather than `never-run`), computed client side. Used by `/a/cron-health`.
3. `/api/admin/overview`, which does `jobs.filter((j) => j.status === "error")` on a raw
   `CronHealthModel.find({}).limit(50)`.

The third is the one on the page an operator opens first, and it is the weakest. A job that is
`late`, `stuck`, or has never run at all is not `status === "error"`, so the admin home renders
**"All ok, 10 jobs reporting"** for a deployment where `notification-emails` died four hours ago. A
job with no `CronHealth` row is not merely un-flagged; it is not in the count either, so "10 jobs
reporting" silently becomes "8".

This is the house's own recurring bug (SECURITY.md §7 bug 7) with the twin being a dashboard rather
than a route. `judgeCronHealth` is pure and importable. The fix is three lines in `overview/route.ts`.

### `/a/shareviews` headline figures are figures about a page of rows

The page fetches `?limit=200` and computes Viewers, Docs touched, Views 24h and Downloads from the
returned array. The endpoint sorts by `updatedDate` desc across the whole collection.

At today's volume this is roughly true. At any real volume, 200 recently-touched rows is less than a
day, and "Views 24h" becomes a floor that converges on 200 and stops moving. Nothing on the page
says the numbers are windowed by row count, so the tile degrades quietly and in the direction that
looks like a plateau in traffic. The endpoint's own cap is 500, which does not change the shape.

The per-document drilldown is fine; it is scoped.

### `/api/admin/credits/snapshot` mutates the workspace it inspects

`/api/admin/credits/balances` goes out of its way to avoid `getCreditsSnapshot`, and its docstring
says why: that function upserts a `WorkspaceCreditBalance` row, seeding the starter grant and the
daily cap, as a side effect.

`/api/admin/credits/snapshot` calls `getCreditsSnapshot` directly. So an admin looking up a
workspace that has never run anything creates its balance row and seeds 50 starter credits by
looking. It is a GET. It is small, it is recoverable, and it is exactly the class of thing an
operator must be able to trust at 3am: inspecting must not change.

### Listings will not time out, but they will drift

Every `data/*` listing uses `.skip((page - 1) * limit)` plus a `countDocuments(filter)` on each
request. That is fine for tens of thousands of rows and slow well before it is dangerous. Worth
knowing rather than worth fixing now.

One real drift: `/api/admin/data/workspaces` defaults to `type: "team"` when no type is given, and
the page defaults its filter to `team`. The home page's Workspaces tile counts every non-deleted
`Org`, personal ones included. The two numbers are meant to be the same thing and are not, and
nothing on either screen says so.

---

## 4. Questions with no home at all

- **"Is the deploy healthy?"** Being built right now in a parallel agent in the same run: `/a/deployments` and
  `/api/admin/deployments` read Vercel's deployment list. That closes the build half. The liveness
  half (is realtime up, is MCP up, is Mongo reachable from the web app) is still nowhere, even though
  `/api/health` and the realtime `/healthz` both answer it.
- **"What is failing right now?"** Section 2. The endpoint exists, the page does not, and the
  collection is probably empty.
- **"Why did this person's email not arrive?"** Answerable only for download requests, which are
  the sole per-message record. For everything else the honest answer is the queue depth and the dead
  letters, which `/a/emails` already gives, and which cannot be searched by recipient. There is no
  "find the row for this address".
- **"Which workspace is burning credits?"** Half answered: on-demand by workspace exists, total
  credit burn by workspace does not, and dollar cost is not collected.
- **"Is anyone being rate limited?"** No.
- **"How much are we storing?"** No.
- **"Who is about to hit a plan limit?"** The `plan-limits` run summary on `/a/emails` says how many
  workspaces were started, reminded and blocked on the last tick. `Org.planGrace` carries `endsAt`,
  `blockedAt` and `remindersSent` per workspace, and the workspace hub renders it for one workspace.
  There is no list of who is in grace right now. This is a sales question as much as an ops one.

---

## 5. What to build, ranked

**1. Turn on error logging, then give it the page it already has an endpoint for.**
Real, and the largest gap by a distance. Set `ERROR_LOGGING_ENABLED=true` in production and add it
to `.env.example`. Then `src/app/a/errors/page.tsx` against `GET /api/admin/errors`: a severity and
category filter bar, grouped by `fingerprint` with a count, the newest occurrence expanded. The
endpoint's filters were written for exactly this page. Nothing else here changes "what is failing
right now" from a Vercel log search into a screen.

**2. Make the admin home's cron verdict the same verdict as everything else.**
Real, and nearly free. Import `judgeCronHealth` into `/api/admin/overview` and return its states.
The current filter tells an operator that a dead deployment is fine, which is worse than saying
nothing. Three lines.

**3. Fix the Views tile, or rename it.**
Real. Either count `ShareVisit` rows over the window (the collection every customer-facing analytics
route already uses, correctly indexed) or relabel the tile "New readers" and change the hint. The
first is right; the second is honest and takes a minute. What must not survive is a number called
"Recipient opens" that is neither.

**4. A fleet page: storage, burn, and who is in grace.**
Real, and it is only a page. Three aggregations over collections that already have the fields and
the indexes: `Upload.sizeBytes` by `orgId`; `CreditLedger` charged credits by `workspaceId` over a
window (extending what `/api/admin/credits/purchases` does for on-demand); `Org.planGrace` where
`endsAt` or `blockedAt` is set. This is the page that answers "which workspace is the problem"
before a customer emails.

**5. Bound the `/a/shareviews` tiles honestly.**
Real but small. Either say "within the rows loaded" on the tiles as the top-documents table already
does, or move the four figures to an aggregate the endpoint computes over the real window. The table
under them is already labelled correctly; the tiles are not.

**6. A liveness strip on the admin home.**
Nice to have, once `/a/deployments` lands. Three fetches (`/api/health`, the realtime `/healthz`,
the MCP's whoami) rendered as three dots. All three endpoints exist and answer today. It is small
enough to ride along with the deployments page rather than justify its own.

**7. Stop `/api/admin/credits/snapshot` writing.**
Nice to have, and correct. Read the balance row directly the way `balances/route.ts` does, and show
em dashes for a workspace that has none, which is what the hub already decided to do.

**8. Retry a dead notification row from `/a/emails`.**
Nice to have. The page already lists the dead letters with their errors; the PRD already proposes
the verb. It is a button and a `status: "pending"` write.

**Not yet: AI cost.** Do not build the page. Fix the write path first: pass `analysisTelemetry` at
the five charge sites that do not, and decide whether `costUsdActual` is going to be written at all
or should be deleted from the schema so it stops looking like an answer. A cost page built on today's
data would be confidently wrong, which is the one failure mode this area cannot afford.

---

## 6. Smaller things found on the way

- `/api/admin/data/orgs` and `/api/admin/data/orgs/[orgId]/members` have no callers anywhere in
  `src/` or `tests/`. They are dead twins of the `workspaces` routes. SECURITY.md §7 bug 5.
- `ERROR_LOGGING_TTL_DAYS` is parsed by `readConfig` and does nothing. The TTL index is fixed at 14
  days in `src/lib/models/ErrorEvent.ts`, and its own comment says changing retention needs
  `scripts/recreate-error-ttl-index.ts`. A knob that silently does not turn.
- `envLabel()` in `src/app/api/admin/errors/route.ts` is defined and unused. Harmless, but it is the
  second copy of a function that already lives in `logger.ts`.
- `/a/tools/cache` is filed under Tools, where an operator will look for something that acts on the
  deployment. It acts on their own browser. A clearer home would be a developer section, or a line
  of copy on the page saying "this browser only".
- The notification queue summary runs two counts on every load of two pages, and its own comment
  flags that the collection grows one row per member per event with a 30-day TTL on `sent`. The
  `sent24h` count is the one that will get slow first. It is indexed, so this is a watch item rather
  than a finding.
