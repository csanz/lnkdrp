# Dashboard pre-production review — 2026-09-19

**Method:** 8-lens multi-agent review of `src/app/dashboard/**` (~6,650 lines) and the 10+ API
routes it calls, every finding then put to 1–3 adversarial verifiers that tried to refute it.
115 agents, 45 candidate findings, 41 survived verification, deduplicated to the list below.

**Status key:** ✅ fixed · ⬜ open

**Update 2026-09-19, second pass:** eleven agents fixed the open findings in parallel (one per
disjoint file set), plus the cross-cutting work afterwards. Everything below is ✅ except the two
items in "Still open" at the end. Verified: `tsc` clean, eslint 0 errors, 1325 + 163 tests pass,
`next build` exit 0.

> Intended for ingestion into metis as tasks. Metis is not currently wired into this repo
> (`~/.claude.json` has only `lnkdrp-usavx`, `lnkdrp-personal` and `superhuman`); run
> `/metis-init` and restart Claude Code, then these become one task each.


## Blockers (2)

### ✅ [security] The Free 3-document cap is bypassable from the per-link routes (documents check only exists on the document-level PATCH)

**Where:** `src/lib/share/links.ts:680`

**What:** `createShareLink` and `updateShareLink` change a document from unshared to shared (via `syncDocShareState`, which sets `Doc.shareEnabled = anyActive`) without ever calling `checkLimit(orgId, "documents")`, so a Free workspace can push its shared-document count past `FREE_DOCUMENTS` indefinitely.

**How it fails:** A Free workspace sits at 3 shared documents (usage.documents = 3, uploads now 402). (1) Owner disables the only link on doc A: `PATCH /api/docs/A/links/{linkId} {enabled:false}` → `syncDocShareState` (links.ts:564) writes `A.shareEnabled = false`, so `getWorkspaceUsage` (planLimits.ts:187 counts `shareEnabled: {$ne:false}`) drops to 2. (2) Upload doc D — `checkLimit("documents")` in src/app/api/docs/route.ts:419 passes (2+1 ≤ 3). Now 3 shared. (3) Re-enable A's link: `PATCH /api/docs/A/links/{linkId} {enabled:true}` → updateShareLink's `set.enabled` branch (links.ts:680-682) runs no documents check, `syncDocShareState` sets `A.shareEnabled = true`. The workspace is now sharing 4 documents on Free with no 402 anywhere. The identical flip through the document switch (`PATCH /api/docs/A {shareEnabled:true}`) IS refused at src/app/api/docs/[docId]/route.ts:922-935, so the gate exists and the link routes route around it. `createShareLink` (links.ts:611-618) is the same hole for a doc whose links are all off: the new link is enabled by default and re-shares the document. Repeating the cycle (disable n, create 1, re-enable n) grows the count without bound, and it is reachable from the dashboard Links panel and from MCP (`lnkdrp_update_share_link` / `lnkdrp_create_share_link`). It also self-amplifies: the next plan-grace sweep sees the workspace over a Free limit with no grace row and hands it a fresh 14-day window (src/lib/billing/planGrace.ts:249-256), and inside that window `checkLimit` returns ok for every counted limit — so one bypass buys 14 days of unrestricted documents, projects and collaborators. The comment at links.ts:680 ("that document is counted whether this link is switched on or off") is the root cause: it is false against planLimits.ts:187.

**Status:** FIXED — `checkLimit(orgId, "documents")` now gates only the unshared→shared transition in `createShareLink` / `updateShareLink`; the doc-level switch keeps its own upstream check via `viaDocSwitch`. 5 regression tests in tests/lib/shareLinks.test.ts.


### ✅ [security] Any workspace member can open the Stripe billing portal and cancel the subscription

**Where:** `src/app/api/billing/subscription/manage/route.ts:15`

**What:** POST /api/billing/subscription/manage authorizes on workspace membership only — it never reads the caller's role — so any member or viewer (and any `lnk_` API key) can mint a Stripe Billing Portal session for the workspace's Stripe customer.

**How it fails:** Owner invites a colleague as `viewer` (TeamsManager offers admin/member/viewer). The dashboard hides the Manage-billing button from them client-side only (`SubscriptionCard.tsx:96` / `BillingInvoicesTab.tsx:686` compute `canManageBilling` in the browser). The viewer opens devtools and runs `fetch('/api/billing/subscription/manage',{method:'POST'})`. Lines 17-22 accept any `kind: "user"` actor, line 30 looks up the org's `stripeCustomerId`, line 40 creates a portal session, and line 47 returns `{ url }`. Opening that URL gives full billing control of the workspace's Stripe customer: cancel the Pro subscription, swap the payment method, read past invoices with the owner's billing name and address. The same request works with a leaked `lnk_` key, because `resolveActor` resolves API keys to `kind:"user"` (`src/lib/gating/actor.ts:367-370`) and this route has no `forbidApiKey` guard.

**Status:** FIXED — `requireOrgRole({minRole:"admin"})` now guards every portal session in /api/stripe/portal (was inside the cancel branch only), plus `forbidApiKey`. The twin route /api/billing/subscription/manage was fixed in parallel by another session.


## Majors (27)

### ✅ [correctness] Every team workspace reports itself as a personal workspace

**Where:** `src/lib/gating/actor.ts:743`

**What:** `resolveActorForStats` (line 743) and `tryResolveUserActorFast` (line 502) hard-code `personalOrgId: orgId`, so every route that derives "is this a personal workspace" from `actor.orgId === actor.personalOrgId` answers `true` for team workspaces whenever the fast path is taken.

**How it fails:** A user switches into a team workspace; /org/switch sets ACTIVE_ORG_COOKIE to the team org id (org/switch/route.ts:143). The next GET /api/plan takes the fast path in `resolveActorForStats`, which returns personalOrgId equal to the team orgId, so plan/route.ts:46 emits `isPersonalOrg: true`. Two consequences the user sees: (1) the Billing & Invoices header (BillingInvoicesTab.tsx:685 → :113) shows the personal-workspace sentence, "Your personal workspace is billed on its own…", on a team workspace that is in fact billed separately from the reader's personal one; (2) GET /api/agent/status (status/route.ts:33) returns the same wrong flag, so KeysPanel.tsx:447/477 passes `showOwner={false}` and LeftSidebar.tsx:2192 drops the `by …` line — the team loses the per-member attribution on agent keys and recent agent activity that the launch decisions call for. The fallback resolver (`tryResolveUserActor`, line 444) computes the real personal org, so the bug appears only for users who have a workspace cookie/claim, i.e. everyone in normal use.

**Suggested fix:** Stop faking the field: either have the two fast paths use `resolvePersonalOrgIdCached(session.userId)` (as `tryResolveUserActorFastWithPersonalOrg` at line 550 already does), or drop `personalOrgId` from the fast-path actor type so callers cannot read a value that was never resolved, and have /api/plan and /api/agent/status read `Org.type === "personal"` instead.


### ✅ [correctness] Billing tab can never show what on-demand usage costs; the API field is always $0.00

**Where:** `src/app/api/billing/summary/route.ts:183`

**What:** `onDemand.usedCentsThisCycle` is derived from `costUsdActual`, a ledger field nothing in the codebase ever writes, so it is always 0 — and the on-demand table derives its Cost/Total the same way, so the Billing & Invoices tab renders "Not available" for every on-demand charge that a Pro customer is actually being billed for.

**How it fails:** A Pro workspace turns on on-demand at $50, burns its 300 included credits and runs 40 more credits on-demand ($4.00, already metered to Stripe by the hourly cron). `createPendingLedger` writes `costUsdActual: null` (mongooseStore.ts:101) and `markLedgerCharged`'s telemetry only carries provider/modelRoute/tokens/latency (analyzePdfText.ts:92-100), so the field stays null forever and `UsageAggCycle.costUsdActual` only ever gets `$inc` by 0 (mongooseStore.ts:341). The owner opens /dashboard?tab=billing: summary returns `usedCentsThisCycle: 0` (line 204, `usdNet` = 0 - 0), and because every on-demand ledger row has a null cost, `/api/billing/usage` marks the bucket unknown (usageAggregation.ts:79-84, 161) so `onDemandHasUnknownCost` is true and the headline renders "Not available / $50.00" (BillingInvoicesTab.tsx:846-858) with "Not available" in every row's Cost and Total column. The same $4.00 is shown correctly one tab away on Limits, because `/api/billing/spend` computes it as credits × `USD_CENTS_PER_CREDIT` (spend/route.ts:190). Any other client reading the documented `onDemand.usedCentsThisCycle` field gets $0.00 for a cycle with real charges.

**Suggested fix:** On-demand is billed at a fixed $0.10/credit, so compute its dollars from credits like `/api/billing/spend` already does: in summary set `usedCentsThisCycle = onDemandUsedCreditsThisCycle * USD_CENTS_PER_CREDIT`, and in `usageAggregation.onDemandCostCentsOrNull` fall back to `creditsFromOnDemand * USD_CENTS_PER_CREDIT` instead of returning null.


### ⬜ [correctness] On-demand credits used in the last hour before cancellation are never billed

**Where:** `src/app/api/cron/stripe-credits-report/route.ts:127`

**What:** The metered-usage cron only builds its workspace→customer map from subscriptions that are currently `active`/`trialing` with a non-null `stripeSubscriptionItemId`, and `customer.subscription.deleted` clears both on the row, so any on-demand ledger rows not yet reported at cancellation time become permanently unbillable.

**How it fails:** A Pro workspace with on-demand on runs AI at 14:05 and 14:20, spending 60 on-demand credits ($6.00). Those ledger rows carry `stripeUsageReportedAt: null`. The subscription ends (the owner cancelled earlier and the period closes, or they cancel immediately) and the webhook's `customer.subscription.deleted` branch sets `status: 'free'` and `stripeSubscriptionItemId: null` (webhook/route.ts:566-576) at 14:40. The cron runs at 14:30 and again at 15:30; the 15:30 run's `SubscriptionModel.find` (line 127-134) no longer matches the workspace, so it is not in `customerByWorkspace`, its ledger rows are never selected by `baseFilter`, and `groupOnDemandLedgersForStripe` would skip them anyway for lack of a customer id. No meter event is ever sent, the credits never land on the final invoice, and `stripe-credits-reconcile` filters on the same `status: { $in: ['active','trialing'] }` so it does not catch them either. The owner loses up to one hour of on-demand revenue on every cancellation.

**Suggested fix:** Build the customer map for reporting from any subscription row that still has a `stripeCustomerId` and unreported on-demand ledger rows (drop the status/item filters for the reporting query, or capture `stripeCustomerId` on the ledger row at reserve time), and keep `stripeCustomerId` on the row when a subscription is deleted so the final batch can still be metered.


### ✅ [correctness] Billing tab shows a 30-minute-stale plan, limit and balances after an upgrade

**Where:** `src/app/api/billing/summary/route.ts:106`

**What:** `/api/billing/summary` returns any cache entry younger than `SUMMARY_CACHE_STALE_MS` (30 minutes) without ever refreshing it — unlike `/api/billing/invoices`, which kicks off a background refresh for stale entries — and nothing invalidates the entry when the plan or the on-demand limit changes.

**How it fails:** A Free workspace owner opens /dashboard?tab=billing (this caches `{plan:{name:'Free'}, onDemand:{enabled:false}, balances:{…}}` under `org:<id>`, line 328), then upgrades to Pro. Stripe's webhook flips the subscription to Pro and grants 300 included credits. Back on the Billing tab, line 101-113 returns the pre-upgrade payload for up to 30 minutes: the plan reads "Free", the cycle window is the old one, `balances.includedRemaining` shows 0 instead of 300, and on-demand reads disabled so the whole on-demand table is hidden (BillingInvoicesTab.tsx:896). The same happens after an owner sets a $50 on-demand limit on the Limits tab — `/api/billing/spend` POST clears `billingSpendCache` (spend/route.ts:282-287) but nothing clears `summaryCache`, so Billing keeps saying "On-demand is disabled for this workspace". A customer who just paid $29 sees a page telling them they are on Free.

**Suggested fix:** Treat `SUMMARY_CACHE_FRESH_MS` as the real TTL (serve stale only while a background refresh runs, as the invoices route does), and delete the `org:<id>` entry from `summaryCache` when the spend limit is written and when the Stripe webhook updates the workspace's subscription.


### ✅ [correctness] Picking a month in the invoice list disables the month picker

**Where:** `src/app/api/billing/invoices/route.ts:212`

**What:** When `month` is passed, the route asks Stripe only for that month's invoices and then derives `months` from that same filtered list, so the response always carries exactly one month — and the client's `<select>` is disabled whenever `months.length <= 1`.

**How it fails:** A customer with invoices in July, August and September opens /dashboard?tab=billing. The first load sends no `month`, so `months` is `['2026-09','2026-08','2026-07']` and the picker offers three options. They select July: the client refetches with `?month=2026-07` (BillingInvoicesTab.tsx:574), the route constrains the Stripe list to July's `created` range (line 205-209) and recomputes `months` from those invoices only (line 212-218), returning `months: ['2026-07']`. `setInvoices(json)` replaces the state the picker renders from, so the `<select>` now has one option and `disabled={… (invoices?.months?.length ?? 0) <= 1}` (BillingInvoicesTab.tsx:978) turns it off. The customer is stuck on July and cannot reach August or September — or the current month — without reloading the page.

**Suggested fix:** Always return the full month list: run the unfiltered `invoices.list` (or reuse the last unfiltered result) to build `months`, and use the `created` range only to select the rows for `selectedMonth`. Alternatively, have the client keep the first response's `months` and never narrow it from a month-scoped response.


### ✅ [correctness] /api/plan reports every workspace as the personal one, so the Billing tab tells team workspaces they are personal

**Where:** `src/app/api/plan/route.ts:46`

**What:** `/api/plan` derives `isPersonalOrg` from `actor.personalOrgId`, but `resolveActorForStats()` fabricates `personalOrgId` as a copy of the active org on its fast path, so `isPersonalOrg` is always `true` for any signed-in user whose active-org cookie/claim resolves.

**How it fails:** Sign in, switch to a team workspace (this sets the `ld_active_org` cookie), open Dashboard → Billing & Invoices. `resolveActorForStats` takes the fast path and returns `{ orgId: <teamOrg>, personalOrgId: <teamOrg> }` (src/lib/gating/actor.ts:743, commented "we don't need personalOrgId ... Keep it stable without extra DB reads"). `/api/plan` then answers `isPersonalOrg: true`, `usePlan()` hands that to `BilledWorkspaceHeader` (src/app/dashboard/BillingInvoicesTab.tsx:685) and the header prints "Your personal workspace is billed on its own…" on a team workspace's billing page. The same expression in `/api/agent/status` (src/app/api/agent/status/route.ts:33) makes `KeysPanel` pass `showOwner={false}` and the sidebar drop the per-member attribution on agent activity, so a team can no longer see which member owns which API key.

**Suggested fix:** Resolve the real personal org for this field: in `/api/plan` and `/api/agent/status` use `tryResolveUserActorFastWithPersonalOrg()`/`resolveActor()` (which sets a true `personalOrgId`), or answer the question directly by reading `Org.type === "personal"` for `actor.orgId` — one indexed lookup, the way `/api/agent/whoami` already does it (src/app/api/agent/whoami/route.ts:68).


### ✅ [correctness] Billing period selector moves the table but not the on-demand total above it

**Where:** `src/app/dashboard/BillingInvoicesTab.tsx:855`

**What:** The big on-demand dollar figure in the "On-demand usage" card always reads the CURRENT cycle from `summary`, while the period `<Select>` right next to it re-fetches and re-renders the table and subtotal for the SELECTED cycle, so the two disagree whenever a past period is chosen.

**How it fails:** A Pro owner opens /dashboard?tab=billing. The period select (line 883-884) is enabled because `cycleOptions` always yields 6 entries once the summary loads. They pick "Period starting Aug 16". `setCycleStartIso` re-runs the usage effect, which fetches `/api/billing/usage?cycleStart=<Aug 16>` and repaints the rows and the "Subtotal" line with August's numbers. The headline directly above still renders `formatUsdFromCents(summary.onDemand.usedCentsThisCycle)` (line 855) and `onDemandLimitLabel` from `summary.onDemand.monthlyLimitCents` — both September values, because `/api/billing/summary` is fetched once with no cycle parameter and is never refetched. The owner reads, say, "$47.20 / $100" as August's on-demand spend when August was $6.10; the subtotal under the same table says $6.10. The correct per-cycle number is already in the payload the tab just received (`usage.onDemand.usedCents`, set in src/lib/billing/usageAggregation.ts:173) and is simply not used.

**Suggested fix:** Render the headline from the selected cycle's usage payload, not the summary: use `usage.onDemand.usedCents` and `usage.onDemand.limitCents` (falling back to the summary values only while `usage` is still loading), so the number, the limit, the table and the subtotal all describe the same period.


### ✅ [correctness] AI quality defaults card saves a fabricated "Standard" when its load failed or was forbidden

**Where:** `src/app/dashboard/AiQualityDefaultsCard.tsx:46`

**What:** `dirty` is hard-coded to `true`, so Save is always enabled, and the tier radios initialise to `"standard"` regardless of what the workspace actually has stored; if the GET fails the card shows those fabricated selections next to an error and a live Save button that will persist them.

**How it fails:** Two concrete paths. (1) Non-admins: page.tsx renders `<AiQualityDefaultsCard/>` on the Limits tab with no role guard, but `GET /api/credits/quality-defaults` returns 403 for any role other than owner/admin (src/app/api/credits/quality-defaults/route.ts:57). A `member` opening /dashboard?tab=limits sees a red "Forbidden" alert, both radio groups showing "Standard" as if that were the workspace default, and an enabled Save that fails with another "Forbidden". (2) Owner/admin with a transient failure: the workspace has AI compare set to Basic (2 credits). The GET fails once (the route wraps every throw as a 400, line 72-75), so `load()` leaves `historyTier` at its initial `"standard"`. The card shows an error but still renders Standard as selected. The admin clicks Save — which `dirty` never disables — and POST writes `defaultHistoryQualityTier: "standard"`. Every later AI compare now bills 5 credits instead of 2, and nothing in the UI ever said the value changed.

**Suggested fix:** Track whether the GET succeeded: hold the tiers as `TierAll | null`, render the radios unselected/disabled until a successful load, and gate Save on `loaded && (reviewTier !== loadedReview || historyTier !== loadedHistory)` instead of the always-true `dirty` memo. Hide or render the whole card read-only when the load returns 403, the same way SpendLimitModule already uses the server's `canEdit` / `editDisabledReason`.


### ✅ [correctness] Billing period selector changes the tables but leaves the dates and dollar total on the current cycle

**Where:** `src/app/dashboard/BillingInvoicesTab.tsx:840`

**What:** The 'Period' `<Select>` sets `cycleStartIso`, which re-fetches both usage tables, but the cycle-range subtitles (lines 753 and 840) and the headline on-demand dollar figure (line 855) all read from `summary`, which is always the current cycle.

**How it fails:** On /dashboard?tab=billing, pick any past period in the On-demand usage card's Period selector (line 884). The effect at line 507 refetches /api/billing/usage for that period, so both the 'Included usage' table and the 'On-demand usage' table repopulate with the older period's rows — but the 'Included usage' subtitle (753) and the 'On-demand usage' subtitle (840) still print `cycleRange`, i.e. today's cycle dates, and the big `$x.xx / $limit` figure at 855 still prints `summary.onDemand.usedCentsThisCycle`, today's spend. The user now reads last period's line items under this period's dates, above this period's total, with nothing indicating the mismatch — and the Included usage card changed under them with no control of its own.

**Suggested fix:** Derive the displayed range and total from the selected period rather than `summary`: use `usage.cycle.start/end` for both subtitles, and show the selected period's on-demand total from `usage.onDemand.usedCents` (falling back to `summary` only while `usage` is loading). Move the Period control above both cards, since it drives both.


### ✅ [correctness] Past billing periods are generated by subtracting a fixed period length, so every historical option is misdated

**Where:** `src/app/dashboard/BillingInvoicesTab.tsx:341`

**What:** `cycleOptions` builds the six selectable periods as `start - i * periodMs` using the current cycle's length, but monthly Stripe cycles are 28–31 days, so each earlier option drifts further from the real invoice period and both its label and the usage it fetches are wrong.

**How it fails:** A workspace whose cycle runs Mar 1 → Apr 1 (31 days) opens /dashboard?tab=billing. The selector offers 'Period starting Jan 29' for what is actually the Feb 1 → Mar 1 period (line 354 builds the label from the computed date). Selecting it sends `cycleStart=2026-01-29&cycleEnd=2026-03-01` to /api/billing/usage (lines 523–528), so the table includes three days of January usage inside a period the user believes is February, under a start date that matches no invoice. Six options back the drift compounds to roughly a week.

**Suggested fix:** Derive the period list from real boundaries rather than arithmetic: add the previous cycle starts to the /api/billing/summary response (Stripe knows them), or key the selector off the invoice months already returned by /api/billing/invoices, and fall back to the current period alone when history is unavailable.


### ✅ [correctness] Dashboard Overview serves Free workspaces 30 days of share-view history, bypassing FREE_ANALYTICS_DAYS

**Where:** `src/app/api/dashboard/stats/route.ts:80`

**What:** `/api/dashboard/stats` hard-codes `rangeDays = 30` and never reads the workspace plan, so a Free workspace gets a 30-day daily series of unique share views and downloads that every other analytics surface clamps to `FREE_ANALYTICS_DAYS` (7).

**How it fails:** A Free workspace opens /dashboard (Overview). `page.tsx:273` fetches `/api/dashboard/stats`; the route builds `series30d` from `ShareView` rows over 30 days with no plan read anywhere in the file, and page.tsx:409-417 renders it under "Last 30 days (UTC). Uploads, docs created, unique share views, and downloads", plus three "Last 30 days" tiles (page.tsx:426-453). The same workspace on /metrics gets 7 days with `clampedByPlan` set and an upsell (src/app/api/metrics/workspace/route.ts:10-12 → src/lib/analytics/workspace/range.ts:80), and every per-document analytics route clamps identically (src/app/api/docs/[docId]/shareviews/route.ts:256). The pricing page sells Free as "views and downloads, last 7 days" (src/app/pricing/page.tsx:127) and the upgrade modal says Pro gives "The full history, not just 7 days" (src/lib/client/upsellCopy.ts:98), so the dashboard hands out, for free, the thing the upsell is selling — and two surfaces in the same product disagree about the same workspace's view history.

**Suggested fix:** Read the plan in the route and clamp: `const rangeDays = clampAnalyticsDays(await getWorkspacePlan(actor.orgId), 30)`, return the window in the payload (as `/api/metrics/workspace` does with `range.clampedByPlan`), and drive the chart heading from it instead of the literal "Last 30 days".


### ✅ [design] Free document cap is per workspace, and workspaces are unlimited and free to create

**Where:** `src/app/api/orgs/route.ts:200`

**What:** `POST /api/orgs` creates a team workspace with no plan check, no cap on how many a user may own and no rate limit, while every paid limit (`documents: 3`, `projects`) is enforced per `orgId`, so the Free document cap costs nothing to step around.

**How it fails:** A Free user shares 3 documents and is blocked by `checkLimit(orgId, "documents")`. They click "New workspace", type a name, and POST /api/orgs succeeds (lines 181-235: membership/auth only — no `checkLimit`, no subscription read, no `rateLimit`). The new workspace is its own tenant with its own fresh Free allowance, so they share 3 more, and repeat: N workspaces = 3N free shared documents, with no upgrade. Scripted, the same endpoint creates workspaces as fast as the user can send requests, each one also running up to 50 `OrgModel.exists` slug probes (ensureUniqueOrgSlug, line 32).

**Suggested fix:** Decide a ceiling and enforce it server-side: count the caller's owned, non-deleted team orgs before `OrgModel.create` and refuse past the limit (Free = 0 or 1 team workspace, Pro = more) with the same `planLimitResponse` shape the other gates use, and add a `rateLimit()` bucket keyed on `orgcreate:<userId>` so the endpoint cannot be looped.


### ✅ [design] Out-of-credits banner CTA is near-unreadable in dark mode

**Where:** `src/app/dashboard/dashboardShell.tsx:311`

**What:** The banner's primary CTA gets a dark: override for its border, background, hover and focus ring but not for its text colour, so `text-stone-900/90` stays near-black on the light-brown dark-mode button.

**How it fails:** A workspace runs out of credits with the app in dark mode. The banner renders and the CTA reads 'Upgrade to Pro' (Free) or 'Increase limit' (Pro). In dark the button background composites to roughly #625950 (`dark:bg-[#f3e7d3]/32` over `bg-amber-500/[0.08]` over `--bg: #0b0b0c`), while the label stays `text-stone-900/90` ≈ #231F1C — about 2.4:1, far under AA for 11px text. The one action that unblocks AI work and takes money is the least legible thing on the banner, while the message beside it (line 305) and the Dismiss button (line 317) both correctly carry dark: variants.

**Status:** FIXED — `dark:text-amber-950` on the CTA.


### ✅ [design] Every dashboard error message loses contrast in dark mode

**Where:** `src/components/ui/Alert.tsx:36`

**What:** `Alert variant="error"` hardcodes `text-red-700` with no dark: override, so error text sits at roughly 2.7:1 on the dark panel — while every hand-rolled error line in the same dashboard correctly pairs `text-red-600 dark:text-red-500`.

**How it fails:** In dark mode, fail any dashboard request — e.g. let /api/dashboard/usage-daily 500 so DailyUsageChart.tsx:247 renders `<Alert variant="error">`, or hit a name-save error at page.tsx:669, a credits-snapshot error at dashboardShell.tsx:454, or any of the five Alerts in BillingInvoicesTab. `text-red-700` (#b91c1c) over `bg-red-500/10` on `--panel: #111113` measures ~2.66:1, below AA for the 12px text these Alerts use. The same codebase gets this right 11 times by hand (TeamsManager.tsx:592, WorkspaceManager.tsx:481, …), so the shared primitive is the one place that missed it.

**Status:** FIXED — `Alert variant="error"` gained `dark:text-red-400`.


### ✅ [performance] Dashboard Overview scans the entire ShareView collection on every load

**Where:** `src/app/api/dashboard/stats/route.ts:144`

**What:** The `ShareView` aggregate that builds the Overview chart opens with a `$match` that carries no tenant predicate at all, so it reads every ShareView row in the database touched in the last 30 days — for every workspace — and only discards the other tenants' rows after a per-row `$lookup` into `docs`.

**How it fails:** Any signed-in user opens /dashboard (or hits GET /api/dashboard/stats, which has no cache and no rate limit; the route can be polled in a loop). The pipeline's first stage is `{ $match: { isOwnerPreview: { $ne: true }, $or: [{ createdDate: {$gte} }, { updatedDate: {$gte} }] } }` — no `orgId`, no `docId` — which no index can serve (the `$or` spans two fields), so Mongo scans the whole collection, then runs a correlated `$lookup` against `docs` per surviving row to drop rows belonging to other workspaces. Results are correct, but one customer's Overview load costs work proportional to *all* customers' traffic, and it gets slower for everyone as the platform grows.

**Suggested fix:** Add the tenant predicate to the first `$match`: `ShareView` already denormalises `orgId` (src/lib/models/ShareView.ts:26) and carries the `{ orgId: 1, createdDate: -1 }` index for exactly this question, and the stats heartbeat `$set`s it on every row (src/app/api/share/[shareId]/stats/route.ts:371). Match `orgId` up front and keep the `$lookup` as the belt-and-braces tenancy check for legacy rows with no `orgId`.


### ✅ [security] Any workspace member can open the Stripe billing portal and cancel the subscription

**Where:** `src/app/api/stripe/portal/route.ts:86`

**What:** The dashboard's "Manage subscription" button creates a Stripe customer-portal session for any signed-in member of the workspace, with no role check, even though the same route gates the cancel flow on owner/admin twelve lines earlier — and a second route, /api/billing/subscription/manage, has no role check at all.

**How it fails:** Alice (owner) invites Bob as `member` or `viewer` to the Pro workspace. Bob opens /dashboard?tab=billing and clicks "Manage subscription" (SubscriptionCard.tsx:312 and BillingInvoicesTab.tsx:124 render it for everyone; only "Resume Pro" and "Cancel subscription" are gated on `canManageBilling`). The POST to /api/stripe/portal has no body, so `wantsCancel` is false at line 52 and the `requireOrgRole(... minRole: "admin")` check at line 66 is skipped entirely. Bob gets a live portal session for the workspace's Stripe customer and, inside Stripe's portal, does exactly what line 67 says only an owner or admin may do — cancels the subscription — plus reads every past invoice (billing address, card last4) and can remove the payment method. POST /api/billing/subscription/manage does the same with no role check on any path.

**Status:** FIXED — `requireOrgRole({minRole:"admin"})` now guards every portal session in /api/stripe/portal (was inside the cancel branch only), plus `forbidApiKey`. The twin route /api/billing/subscription/manage was fixed in parallel by another session.


### ✅ [security] An API key scoped to one workspace can make its owner leave a different workspace

**Where:** `src/app/api/orgs/[orgId]/leave/route.ts:19`

**What:** `/api/orgs/:orgId/leave` resolves through `resolveActor`, which accepts an `lnk_` bearer (actor.ts:368 → tryResolveApiKeyActor), but it never calls `forbidApiKey` and it takes the org from the path rather than from the key's own workspace — so a key issued for workspace A can soft-delete its creator's membership in workspace B.

**How it fails:** A member of workspaces A and B mints a write-scoped API key in A and puts it in an agent's config. The agent (or anyone who reads that config file) sends `POST /api/orgs/<B-id>/leave` with `Authorization: Bearer lnk_…`. `apiKeyActor` returns an actor whose `orgId` is A but whose `userId` is the key's creator; the route ignores `actor.orgId`, checks only that that user is a member of B (line 41), and soft-deletes the membership at line 54 plus records `member.left` in B's activity feed. The person loses access to workspace B and needs a fresh invite to get back in. `/api/orgs/:orgId/avatar` (line 32) and `/api/org-invites/revoke` (line 16, orgId from the body) have the same shape: a key for A mutates B. This is precisely the class the new `forbidApiKey` helper was written for — it is already applied to rename, delete-workspace, remove-member, invite-by-email and account-delete, and `leave` (removing *yourself*) was missed.

**Status:** FIXED — `forbidApiKey` on /api/orgs/[orgId]/leave, /api/org-invites/revoke and /api/orgs/[orgId]/avatar.


### ✅ [security] A pending invite can never be revoked from the dashboard

**Where:** `src/app/dashboard/TeamsManager.tsx:841`

**What:** The Invites table renders every invite as read-only text with no revoke control, and `POST /api/org-invites/revoke` has no caller anywhere in the codebase, so an invite link that was created or emailed by mistake stays claimable until it expires.

**How it fails:** An owner sends an Admin invite to the wrong address (a typo, or a generated link pasted into the wrong Slack channel). They open Dashboard -> Teams -> Invites, see the row with status "Not used", and there is no button to cancel it — the row only offers copy-the-link (TeamsManager.tsx:871-884). The only remaining remedies are waiting out the 14-day TTL or deleting the workspace, and whoever holds the link can join as admin at any point during those 14 days. `grep -rn "org-invites/revoke" src` matches only the route file itself, confirming the working endpoint (src/app/api/org-invites/revoke/route.ts) is unreachable from the product.

**Suggested fix:** Add a Revoke action to unused invite rows that POSTs `{ inviteId: inv.id, orgId: activeOrgId }` to /api/org-invites/revoke and then calls loadExistingInvites({ force: true }); the route already enforces owner/admin and refuses already-redeemed invites.


### ✅ [security] Visiting an invite URL joins the workspace and silently repoints the active workspace

**Where:** `src/app/org/join/[token]/page.tsx:58`

**What:** The join page claims the invite from a `useEffect` on mount and then navigates to /org/switch, so a signed-in user is made a member and has their active workspace changed by merely opening a URL — there is no screen asking whether they want to join, and no way to decline.

**How it fails:** An attacker (or any stranger who obtained a link, see the two findings above) sends a signed-in lnkdrp user a /org/join/<token> URL. Opening it POSTs the claim, then window.location.assign(`/org/switch?orgId=…`) (page.tsx:70). /org/switch validates membership — which now passes — and persists the attacker's org into User.metadata.activeOrgId plus the active-org cookie (src/app/org/switch/route.ts:117-121, 143-150), landing the victim on "/" inside that workspace. The victim's next PDF upload is created in the attacker's workspace, where the attacker can read the document and its view analytics; the attacker also gains the victim's name, email and last-login from the members list.

**Suggested fix:** Render an explicit confirmation on /org/join/<token> — workspace name, role and the account the user is signed in as, with Join and Cancel — and only POST the claim and switch workspaces after Join is clicked.


### ✅ [security] Any member or viewer can open the workspace's Stripe billing portal

**Where:** `src/app/api/stripe/portal/route.ts:86`

**What:** `POST /api/stripe/portal` with an empty body creates a Stripe billing portal session for the workspace's customer after checking only that the caller is a signed-in member of the active org — no role check — while the cancel flow in the same handler (line 66) and every other billing mutation are gated to owner/admin.

**How it fails:** A user invited to a team workspace as `member` (or even `viewer` — `requireOrgRole` ranks viewer lowest and nothing here calls it) opens devtools and runs `fetch('/api/stripe/portal',{method:'POST'})`. The route resolves the actor (line 40), reads the org's `stripeCustomerId` from `SubscriptionModel` (line 53) and returns a Stripe-hosted portal URL for the owner's customer. In that portal the member can read and download every invoice and receipt for the workspace, and update or remove the card on file — removing it makes the next Pro renewal and the next metered on-demand invoice fail, which the webhook then turns into `status: past_due` and a disabled on-demand. Cancellation is reachable there too: this app's own `flow_data: { type: 'subscription_cancel' }` call at line 73 only works when `subscription_cancel` is enabled in the portal configuration, and with it enabled the plain portal exposes the same cancel button that line 67 refuses to give a member. The dashboard already treats this as owner/admin-only: SubscriptionCard.tsx:96 hides "Manage billing"/"Cancel subscription" behind `canManageBilling`, so the API is the only thing standing.

**Status:** FIXED — `requireOrgRole({minRole:"admin"})` now guards every portal session in /api/stripe/portal (was inside the cancel branch only), plus `forbidApiKey`. The twin route /api/billing/subscription/manage was fixed in parallel by another session.


### ✅ [security] Workspace-avatar upload tokens are minted for 250 MB files to any member, with no rate limit

**Where:** `src/app/api/blob/upload/route.ts:151`

**What:** The Blob client-upload route mints avatar tokens with `maximumSizeInBytes: CLIENT_UPLOAD_MAX_SIZE_BYTES` (250 MB, the document ceiling) for anyone holding any membership row in the target org, so the 2 MB / square / ≥120px avatar rules are enforced only in the browser.

**How it fails:** A signed-in user (any role, including `viewer`, in any workspace they belong to — including the personal workspace every account gets for free) POSTs `/api/blob/upload` with `pathname: "org-avatars/<orgId>/x.png"`. `authorizePathname` only checks `OrgMembershipModel.exists` (lines 103-114), and `onBeforeGenerateToken` returns a token allowing 250 MB of `image/png` (src/lib/blob/serverClientUploadRoute.ts:124 → BROWSER_DIRECT_UPLOAD_MAX_BYTES = 250 MB, src/lib/limits/uploads.ts:60). The client-side size/dimension checks in WorkspaceManager.tsx:355-370 are never reached. Nothing rate-limits session callers on this route (`actorRateLimitResponse` only maps API-key/temp-user errors), and the uploaded blobs are never attached to anything, so they are never cleaned up — an attacker writes unbounded public Blob storage billed to the product's account.

**Suggested fix:** Give the avatar prefix its own ceiling in `allowedContentTypesForPathname`'s neighbourhood — e.g. an `maximumSizeInBytesForPathname()` returning ~2 MB for `org-avatars/` and `BROWSER_DIRECT_UPLOAD_MAX_BYTES` for `docs/` — and require owner/admin for the avatar prefix so it matches who is allowed to set the avatar in `/api/orgs/[orgId]/avatar` (line 52).


### ✅ [security] Invite emails are an unrated mailer: any address, unlimited sends, attacker-controlled body

**Where:** `src/app/api/org-invites/email/route.ts:148`

**What:** `POST /api/org-invites/email` sends mail from the product's verified domain to any address the caller names, with the workspace name interpolated into the subject and body, and there is no rate limit of any kind on the route.

**How it fails:** An attacker creates a team workspace (POST /api/orgs, unlimited) and subscribes it to Pro. `checkLimit(orgId, "collaborators")` at line 120 passes as long as the workspace has no collaborator yet (Pro allows 1, used 0), and it never becomes false because an *unredeemed* invite adds no member. The attacker then loops POST /api/org-invites/email with `email` set to any victim address: each call creates an OrgInvite row and calls `sendOrgInviteEmail` (line 148), which puts the workspace name straight into `subject` and the text body (src/lib/email/sendOrgInviteEmail.ts:28-41). Because POST /api/orgs accepts an unvalidated name (see the separate finding), the "workspace name" can be a multi-line paragraph, so the recipient gets attacker-written text delivered from `INVITE_EMAIL_FROM` — spam and phishing carried by the product's sending reputation, at whatever rate the attacker wants.

**Status:** FIXED — rate limited: 20 per workspace/hour, 3 per recipient/hour (hashed), via the existing `rateLimit` helper.


### ✅ [security] Any workspace member or viewer can read the workspace's Stripe invoices and open its hosted invoice links

**Where:** `src/app/api/billing/invoices/route.ts:101`

**What:** `/api/billing/invoices` authorizes on membership alone — it never checks the caller's org role — so a `member` or `viewer` receives every invoice amount, status and `hosted_invoice_url` for the workspace.

**How it fails:** A workspace owner invites someone as `viewer` (TeamsManager offers Member/Viewer/Admin at src/app/dashboard/TeamsManager.tsx:678-681). That viewer opens /dashboard?tab=billing. `BillingInvoicesTab` gates only the management controls by role (`canManageBilling = role === "owner" || "admin"`, line 686), but the Invoices card renders for everyone (lines 970-1030) and fetches `/api/billing/invoices` (line 575). The route checks `actor.kind !== "user"` and a valid orgId (lines 102-103) and nothing else, then returns rows including `hostedInvoiceUrl` (line 177) — a Stripe-hosted page that shows the billing name/address/email on the customer record and offers the invoice PDF and payment. This contradicts the codebase's own rule (src/lib/orgs/requireOrgRole.ts:4 "membership alone is not authorization") and its sibling billing routes: `/api/billing/spend` POST and `/api/credits/quality-defaults` both 403 non-owner/admin, and `/api/dashboard/usage-daily` computes `canViewSpend` from role for far less sensitive data.

**Status:** FIXED — owner/admin check + `forbidApiKey` on /api/billing/invoices.


### ✅ [security] Workspace invoices and Stripe hosted-invoice links are readable by any member

**Where:** `src/app/api/billing/invoices/route.ts:98`

**What:** GET /api/billing/invoices checks membership but not role, and returns each invoice's `hostedInvoiceUrl` — Stripe's hosted invoice page, which shows the payer's billing name, address and card last4.

**How it fails:** A `member` or `viewer` calls `GET /api/billing/invoices`. Lines 102-103 accept any user actor with a valid org; line 110 reads the org's `stripeCustomerId`; lines 226-245 build rows including `hostedInvoiceUrl` from `inv.hosted_invoice_url`; line 250 returns them. The member now has the owner's billing history, amounts, and clickable Stripe invoice pages carrying the owner's billing address. `/api/dashboard/usage-daily/route.ts:80` gates far less sensitive spend figures on `role === owner || admin`, so this is an omission rather than a policy choice. Reachable by an API key too (`resolveActorForStats` resolves `lnk_` bearers).

**Status:** FIXED — owner/admin check + `forbidApiKey` on /api/billing/invoices.


### ✅ [security] A document-scoped API key can raise the workspace's on-demand billing limit

**Where:** `src/app/api/billing/spend/route.ts:229`

**What:** POST /api/billing/spend resolves the actor with `resolveActorForStats`, which accepts `lnk_` API keys, and has no `forbidApiKey` guard — so a key can set how much money the workspace may be billed for on-demand credits.

**How it fails:** An agent config leaks a `lnk_` key issued by a Pro workspace owner. The attacker posts `{"spendLimitCents": 100000000}` to `/api/billing/spend`. Line 231 resolves the key to `kind:"user", viaApiKey` (`src/lib/gating/apiKeyActor.ts:100-105`); line 233 passes; the Pro check at line 256 passes because the workspace is Pro; the role check at line 269 passes because it reads the *key creator's* role and owners are the ones who create keys; line 274 writes `onDemandEnabled: true` with the capped limit. On-demand AI usage is then billed to the owner's card up to that ceiling, and by the route's own header comment (lines 8-12) credits already burned stay billed even after the limit is turned back off. `src/lib/gating/forbidApiKey.ts:14` states the rule this breaks verbatim: "keys do document work, not identity work **and not money**." No scope is required — `verifyBearerToken` never checks scopes, so a read-only key works.

**Status:** FIXED — `forbidApiKey` on POST /api/billing/spend.


### ✅ [security] Dashboard routes return raw exception text to the browser and log nothing in production

**Where:** `src/app/api/dashboard/stats/route.ts:259`

**What:** Thirteen dashboard-facing routes catch every error and return `err.message` verbatim with status 400 instead of going through `errorJson`, so Mongo and Stripe internals reach the client while nothing at all reaches Vercel Logs or `errorevents`.

**How it fails:** On deploy day `STRIPE_SECRET_KEY` is wrong, or Atlas rejects a connection. `/api/dashboard/stats:260-261`, `/api/billing/status:110-111`, `/api/billing/subscription/manage:49-50`, `/api/billing/subscription:80-81`, `/api/billing/spend:297-298`, `/api/credits/purchase:107`, `/api/orgs:175-177`, `/api/orgs/active:32-34`, `/api/orgs/[orgId]/avatar:66-68`, `/api/orgs/claim-join:153`, `/api/org-invites/claim:176` and `/api/users/me/name:62` each return `{error: <raw driver message>}`. `fetchJson` (`src/lib/http/fetchJson.ts:32-35,77`) and the dashboard's own handlers (`page.tsx:275`, `SubscriptionCard.tsx:70`) lift that string straight into an on-screen `Alert`, so the user reads e.g. `No such customer: 'cus_Sx…'` or a Mongo message naming the cluster host. Server side nothing is recorded: the few that log use `debugError(1, …)`, a no-op with `DEBUG_LEVEL` unset in production (`src/lib/debug.ts:39,58-61`), and the 400 status means `logErrorEvent` (which only fires at ≥500, `errorResponse.ts:77`) never writes to `errorevents`. DEPLOY.md:1519-1521 tells the operator only Stripe Checkout and upload processing behave this way, so the runbook understates it by eleven routes.

**Suggested fix:** Replace each of those catch blocks with `return errorJson(err, { status: 500, publicMessage: "…", context: "[api/<route>] <METHOD> failed" })`, which redacts and logs one line always and suppresses `detail` in production; then correct the DEPLOY.md paragraph at line 1519.


### ✅ [security] `/org/switch` open redirect: a leading `/\` defeats the returnTo check

**Where:** `src/app/org/switch/route.ts:29`

**What:** `safeReturnTo` rejects only values not starting with `/` and values starting with `//`, but `/\host` is parsed by browsers as protocol-relative, so it escapes the origin.

**How it fails:** A colleague in a shared workspace sends `https://app.lnkdrp.com/org/switch?orgId=<the shared workspace id>&returnTo=/%5Cevil.example/login`. `url.searchParams.get` decodes it to `/\evil.example/login`; line 32 passes (starts with `/`), line 34 passes (does not start with `//`). The route sets the active-org cookie and emits the branded "Switching workspace…" page, which fires `<meta http-equiv="refresh" content="4;url=/\evil.example/login">` (line 166) and `window.location.replace("/\\evil.example/login")` (line 320). Verified with the same WHATWG parser browsers use: `new URL('/\\evil.example/x','https://app.lnkdrp.com/dashboard').href` → `https://evil.example/x`. The victim lands on an attacker page one hop after a genuine lnkdrp interstitial. `switchWorkspaceWithOverlay` (`SwitchingOverlay.tsx:214-216`) passes the same value to `window.location.assign`, so the JSON path is affected too.

**Status:** FIXED — `safeReturnTo` now parses the value and accepts same-origin paths only, so `/\\host` no longer escapes.


## Minors (12)

### ✅ [correctness] Invite counts and older pending invites are silently truncated at 25

**Where:** `src/app/api/org-invites/route.ts:129`

**What:** GET /api/org-invites returns only the 25 newest non-revoked invites with no pagination, while TeamsManager computes the Not used / Used / Expired / All tab counts from exactly that truncated array, so both the numbers and the list are wrong once a workspace has passed 25 invites.

**How it fails:** A workspace that has issued 40 invites over a few months opens Teams -> Invites. inviteCounts (TeamsManager.tsx:320-334) counts only the 25 rows the API returned, so the tabs read e.g. "Not used (3)" when 9 unredeemed links are actually outstanding, and the 15 oldest invites — some still unexpired and claimable — never appear in any filter, including "All". Combined with the missing revoke control, an admin auditing who can still get in is shown a list that is both incomplete and labelled with a confident count.

**Suggested fix:** Either paginate (accept a cursor/skip and return a `hasMore` flag the UI surfaces) or return server-computed counts alongside the page so the tab labels do not come from a truncated array.


### ✅ [correctness] OrgInvite's partial index uses $ne, which MongoDB rejects

**Where:** `src/lib/models/OrgInvite.ts:43`

**What:** `partialFilterExpression: { isRevoked: { $ne: true } }` is not a legal partial-index filter — MongoDB allows only equality, $exists:true, $gt/$gte/$lt/$lte, $type, $and/$or/$in — so this index is never created and the query it was written for runs without it.

**How it fails:** On a fresh production database, the first use of the OrgInvite model triggers Mongoose's default autoIndex build, and createIndex fails with "Expression not supported in partial index", surfaced as a model index error rather than a caught application error. The {orgId, createdDate:-1} index the comment describes never exists, so the Teams -> Invites listing (find by orgId, sort createdDate desc, limit 25) falls back to the single-field orgId index plus an in-memory sort. Every other partial index in the codebase uses a supported operator ($type/$exists), so this one is the outlier.

**Suggested fix:** Change the filter to `{ isRevoked: false }` — both creation paths (org-invites/route.ts:263 and email/route.ts:138) write isRevoked explicitly — or drop the partialFilterExpression and keep the plain compound index.


### ✅ [correctness] Workspace delete confirmation asks for the unsaved name in the form field

**Where:** `src/app/dashboard/WorkspaceManager.tsx:793`

**What:** The delete confirmation prompt and placeholder interpolate `manageOrgName`, which is the live (possibly edited and unsaved) value of the Name input, while the server compares the typed phrase against the workspace name actually stored.

**How it fails:** An owner opens Manage on "Acme", types "Acme Corp" into the Name field but does not click Save, then scrolls to Danger zone and clicks "Delete workspace…". The dialog instructs "Type delete Acme Corp" and the input's placeholder says the same. They comply, click Delete, and `DELETE /api/orgs/:id` rejects it with 400 `Confirm by typing: delete acme` (src/app/api/orgs/[orgId]/route.ts:155-157), because `expected` is built from the stored name. The owner is told to type something different from what the dialog just told them to type.

**Status:** FIXED — uses `baselineOrgName`.


### ✅ [correctness] Invite controls act enabled before the plan snapshot resolves, so Free owners get a raw plan-limit error

**Where:** `src/app/dashboard/TeamsManager.tsx:169`

**What:** `inviteBlockedByPlan` is computed as `plan?.plan === "free"`, which is `false` while `usePlan()` is still `null`, so during the first load the Generate-link and Send-invite controls are fully enabled for a Free workspace and the upgrade notice that is supposed to replace them is not rendered.

**How it fails:** An owner of a Free shared workspace loads /dashboard?tab=teams&subtab=invites. `usePlan` starts at `null` (src/lib/client/usePlan.ts:79) and the `/api/plan` round trip takes a few hundred ms. In that window the role select and "Generate link" button render enabled with no upgrade notice, and the email field accepts input. A user who clicks immediately hits `POST /api/org-invites`, which runs `checkLimit(orgId, "collaborators")` and returns `planLimitResponse` (src/app/api/org-invites/route.ts:236-246); `createInvite` surfaces that as a bare red line under the header instead of the designed UpsellCopy notice with its Upgrade button. Once the snapshot lands the controls grey out, so the same click a second later behaves completely differently.

**Suggested fix:** Treat an unresolved plan as blocking for this control: gate on `plan === null || plan.plan === "free"` for the `disabled` props (or render the invite panel's skeleton until `usePlan().loading` is false), so the buttons never open a path the plan forbids.


### ✅ [correctness] `/api/plan` always reports isPersonalOrg: true, so the Billing tab calls every team workspace "your personal workspace"

**Where:** `src/app/api/plan/route.ts:46`

**What:** `/api/plan` derives `isPersonalOrg` from `actor.orgId === actor.personalOrgId`, but `resolveActorForStats`'s fast path sets `personalOrgId: orgId` as a deliberate shortcut (src/lib/gating/actor.ts:741-743), so the comparison is true for every signed-in caller regardless of workspace.

**How it fails:** A user whose active workspace is the team org "Acme" (active-org cookie set, membership valid — the normal dashboard case) opens /dashboard?tab=billing. `resolveActorForStats` takes the fast path and returns `{orgId: Acme, personalOrgId: Acme}`; `/api/plan` serializes `isPersonalOrg: true`; `BillingInvoicesTab` passes it to the header (line 686) which then renders, directly under the heading "Billing for Acme · Free", the line "Your personal workspace is billed on its own. Each team workspace has a separate plan, credits and invoices." (line 114) instead of the team wording at line 115. The card's stated purpose (comment at lines 39-43) is to make clear which workspace a subscription will pay for, and it currently says the wrong one on every team workspace.

**Suggested fix:** Stop deriving it from the actor: resolve it from the org document (`OrgModel.findOne({_id: orgId}).select({type:1})` → `type === "personal"`), which is what the client-side surfaces already use (src/app/dashboard/TeamsManager.tsx:160). Leaving `personalOrgId` as the fast-path shortcut is fine; this route just must not read it as a fact.


### ✅ [correctness] A Pro workspace is told to "Upgrade to Pro" when the billing status call fails

**Where:** `src/app/dashboard/dashboardShell.tsx:233`

**What:** The shell treats a non-ok `/api/billing/status` response as "free" rather than "unknown", so a failed status read silently downgrades the plan the out-of-credits banner is written for.

**How it fails:** A Pro workspace exhausts its monthly credits, so `credits.blocked` is true and the banner renders. `/api/billing/status` then 400s — which it does for any Mongo hiccup, because its own catch (`route.ts:109-111`) turns every exception into a 400. At line 233 `res.ok` is false, so `p` becomes `""`, and line 235 sets `plan` to `"free"` (the `catch` at 236 correctly leaves it `null`, but a non-ok response never reaches it). The banner at lines 299-303 then shows a paying Pro customer "You've used your starter credits; Pro includes N a month" with an "Upgrade to Pro" button linking to `/pricing`, instead of "Increase limit" → `/dashboard/limits`.

**Suggested fix:** At line 233-235, leave `plan` as `null` unless the response was ok and carried a recognised plan string — i.e. `if (!res.ok || (p !== "pro" && p !== "free")) return;` before `setPlan`, matching how `CreditsSummaryCard.tsx:78` falls back to an explicit `"unknown"`.


### ✅ [design] Admins are offered a "Delete workspace" flow the server refuses with "Not found"

**Where:** `src/app/dashboard/WorkspaceManager.tsx:787`

**What:** The Manage panel opens for owner *and* admin (WorkspaceManager.tsx:511, :563), but the Danger zone's "Delete workspace…" button is gated only on `!manageOrgId` — while DELETE /api/orgs/:orgId is owner-only and answers a non-owner with 404 "Not found".

**How it fails:** An admin (not owner) of a team workspace opens Workspace → Manage… → Danger zone, clicks "Delete workspace…", reads the member/doc/upload counts, types the exact confirmation phrase `delete <Workspace Name>`, and presses Delete. `deleteOrg` (line 419) POSTs and orgs/[orgId]/route.ts:146 returns 404 `{error:"Not found"}` because `isOwner` is false, so the banner reads "Not found" — a message that reads as a broken app rather than "only the owner can do this". The same panel is reachable for a personal workspace, where the server answers 400 "Cannot delete personal org" instead.

**Status:** FIXED — delete is owner-only in the UI, and the confirmation phrase uses the saved name rather than the unsaved edit.


### ✅ [design] "Remove" is offered against the owner and against fellow admins

**Where:** `src/app/dashboard/TeamsManager.tsx:621`

**What:** The Members list renders Remove for every row that is not the viewer's own (`m.userId && !isSelf`), ignoring both the target's role and the viewer's, while the server permits owner→admin/member/viewer only and admin→member/viewer only.

**How it fails:** An admin opens Teams → Members and clicks Remove next to the owner; the RemoveMemberModal confirms the removal (and promises the person will be emailed), then POST /api/orgs/:orgId/members/:userId/revoke returns 400 "Cannot remove owner" (revoke/route.ts:57). Admin-on-admin gets 403 "Insufficient permissions" (line 58) after the same confirmation. The authorization holds — only the affordance is wrong.

**Status:** FIXED — the Remove button now mirrors the revoke route's matrix (owner: anyone below; admin: member/viewer only).


### ✅ [design] Remove renders on member rows the server will always refuse

**Where:** `src/app/dashboard/TeamsManager.tsx:621`

**What:** The Remove button is rendered for every row whose email differs from the signed-in user's, with no regard for the target's role or the viewer's, so it appears next to rows the revoke route rejects by design.

**How it fails:** An admin opens Teams -> Members, sees Remove next to the workspace owner, clicks it, reads the RemoveMemberModal warning about the member losing access, confirms — and gets "Cannot remove owner" (src/app/api/orgs/[orgId]/members/[userId]/revoke/route.ts:57) inside the dialog. The same dead end happens when an admin tries to remove another admin (403 "Insufficient permissions", same file line 58-60). The self-check is also email-based (TeamsManager.tsx:600-603), so a member whose user record has no email sees Remove on their own row and gets a 400.

**Status:** FIXED — same matrix fix as above.


### ✅ [design] Remove button is offered on members the current admin is not allowed to remove

**Where:** `src/app/dashboard/TeamsManager.tsx:621`

**What:** The member row shows Remove for every member who is not the viewer themselves, ignoring the role rules the revoke route enforces — an admin is offered Remove on the owner and on fellow admins.

**How it fails:** An admin of a shared workspace opens /dashboard?tab=teams. The owner's row and every other admin's row carry a Remove button, because the only condition is `m.userId && !isSelf`. Clicking it opens RemoveMemberModal, which states the consequences of removal, and confirming fires the POST, which returns 400 "Cannot remove owner" or 403 "Insufficient permissions" (src/app/api/orgs/[orgId]/members/[userId]/revoke/route.ts:57-60). The error lands inside the dialog after the admin has already committed to a destructive action they were never permitted to take.

**Status:** FIXED — same matrix fix as above.


### ✅ [design] The Limits tab shows the same on-demand usage panel twice, side by side

**Where:** `src/app/dashboard/page.tsx:591`

**What:** The two-column Limits grid puts OnDemandUsageCard next to a card whose body is SpendLimitModule, and both render the same used/limit credits, the same dollar line, the same progress bar and their own help tooltip — with SpendLimitModule's own bordered panel nested inside an identically coloured bordered card.

**How it fails:** Open /dashboard?tab=limits. Left column: a card headed 'On-demand usage' with a HelpTooltip and a used/limit figure over a progress bar (OnDemandUsageCard.tsx:91–136). Right column: a card headed 'On-demand limit' with a second HelpTooltip and the subtitle 'Turn on-demand on or off, and cap it', inside which SpendLimitModule renders a third heading — 'On-demand usage this cycle' — a third HelpTooltip, and the same used/limit figure over the same progress bar (SpendLimitModule.tsx:244–307). Because SpendLimitModule's root is `rounded-xl border border-[var(--border)] bg-[var(--panel)]` (line 240) and the wrapper at page.tsx:593 is also `bg-[var(--panel)]`, the right column is a border drawn inside a border over the same fill. The tab's whole first screen is one fact stated twice.

**Suggested fix:** Drop OnDemandUsageCard from the Limits grid and let SpendLimitModule be the single on-demand panel (it already carries the numbers, the bar and the controls), or strip the duplicated numbers/bar/tooltip out of SpendLimitModule when it is not `compact` and give it `bg-transparent border-0 p-0` so it reads as the body of its wrapper card rather than a nested panel.


### ⬜ [design] Only the Billing tab uses the shared Panel, so its cards have the light-theme shadow and the rest of the dashboard does not

**Where:** `src/app/dashboard/BillingInvoicesTab.tsx:745`

**What:** BillingInvoicesTab is the sole dashboard file importing src/components/ui/Panel; every other card is a hand-rolled `rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:p-6`, which omits the `shadow-[var(--shadow-card)]` Panel applies.

**How it fails:** In the light theme (`--shadow-card: 0 1px 2px …, 0 1px 3px …`, globals.css:31), switch between tabs. The Billing tab's three cards sit slightly raised off the page; the cards on Overview (page.tsx:403, 424, 457, 470), Usage (DailyUsageChart.tsx:185, UsageTable.tsx:155, CreditsSummaryCard.tsx:156), Limits (page.tsx:593, OnDemandUsageCard.tsx:89, AiQualityDefaultsCard.tsx:93) and Account (page.tsx:498, 506) are flat. Commit 59d07a5 ('the light theme has depth') introduced that lift, and six of the seven tabs never got it. In dark mode `--shadow-card` resolves to none, so the split is invisible there and easy to miss.

**Suggested fix:** Replace the hand-rolled card divs across src/app/dashboard/* with `<Panel padding="lg">` (or `<Panel className="p-4 sm:p-6">` where the responsive padding matters), so a future change to the card treatment lands everywhere at once.

---

## Still open

### ⬜ [correctness] On-demand credits used in the last hour before cancellation are never billed

Deliberately not fixed. The metered-usage cron builds its customer map only from `active`/`trialing`
subscriptions, and `customer.subscription.deleted` clears the fields it keys on. The tempting fix —
dropping those filters — would make us *report* the usage, but Stripe creates the final invoice at
cancellation, so a meter event arriving afterwards likely lands nowhere and we would be left with
"reported but never billed" ledger rows: worse than an honest gap.

The right fix is to flush unreported usage inside the `customer.subscription.deleted` webhook,
before it clears `stripeSubscriptionItemId` — the handler already does its on-demand teardown there
"first, needs the workspace mapping, which the row still holds". That needs the cron's reporting
logic extracted into a lib function and confirming against real Stripe behaviour, ideally in the
sandbox.

### ⬜ [design] Only the Billing tab uses the shared `Panel`

Every other dashboard card is a hand-rolled `rounded-2xl border … p-4 sm:p-6` that omits Panel's
`shadow-[var(--shadow-card)]`. Cosmetic, and a sweeping rename across every dashboard file — left
out of the parallel pass precisely because it touches every file at once. Worth doing in one quiet
commit.

### Smaller follow-ups handed back by the fix agents

- `/api/billing/usage` returns the workspace's *current* on-demand limit for any cycle, so the
  `/ $50.00` denominator on a past period is today's limit, not the one that applied then.
- Real previous-cycle boundaries should come from Stripe via `/api/billing/summary` (`cycles: [{start, end}]`)
  rather than being inferred client-side from the current anchor — correct for monthly plans today.
- `SpendLimitModule`'s bordered panel is still nested inside the identically filled "On-demand limit"
  card. One border inside another; needs the module itself, since `cn()` has no tailwind-merge.
- The avatar size ceiling lives in the blob route rather than `src/lib/limits/uploads.ts`, which
  claims to be the one place upload limits are defined.
- Orphaned avatar blobs (upload started, never attached) are never collected. Needs a cleanup job.
- `AiQualityDefaultsCard` is still visible to members who cannot edit it; the route would need to
  return a `canEdit` flag for the read-only treatment `SpendLimitModule` already has.
- Three other invite queries still filter with `isRevoked: { $ne: true }` and so cannot use the
  corrected partial index. They are correct, just not index-served.
