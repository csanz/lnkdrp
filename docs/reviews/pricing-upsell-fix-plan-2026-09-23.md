# Pricing and upsell fix plan — 2026-09-23

Companion to `pricing-upsell-analysis-2026-09-23.md`. Six phases, each shippable on its own and ordered by money at risk, then by conversion impact, then by effort. Every task names the files, the change, and the acceptance check. Sizes: S = under half a day, M = one to two days, L = three days or more.

The broader code review (`full-code-review-2026-09-23.md`) has its own order of work; this plan pulls in only the findings that sit on the purchase path.

---

## Phase 0 — Stop the bleeding (money safety)

These are bugs that charge cards or lose revenue today. Do them before any pricing change, because every later phase sends more traffic through this path.

**Status 2026-09-24: done.** 0.3, 0.4 and 0.5 were swept into the other agent's commit `bb19104` on `next-release`; 0.1, 0.2, 0.6, 0.7 are in the working tree, uncommitted. `tsc`, `npm run lint` and `npm test` pass. 0.2 shipped as "schedule cancel at period end" rather than "refuse deletion"; where another owner/admin remains it leaves the subscription and posts a `plan.subscription_ending` activity row asking them to replace the card. See `agent-overlap-audit-2026-09-24.md` for the audit that found the yearly-billing interactions, closed as 0.8 below.

### 0.8 Yearly Pro interactions (from the overlap audit) — S, done 2026-09-24
- `src/lib/credits/serviceCore.ts`: `defaultIsProWorkspace` reads `interval` and answers `onDemandEligible`, so a yearly row never allocates on-demand credits nothing would bill.
- `src/app/api/stripe/webhook/route.ts`: `interval === "year"` nulls `stripeSubscriptionItemId` and switches on-demand off. Two yearly cases added to `tests/lib/stripeWebhook.test.ts`.
- `src/lib/accounts/purge.ts`: skips subscriptions already set to cancel at period end (no forfeiture of a prepaid year); `DELETE /api/orgs/:orgId` cancels yearly with `prorate: true`.
- `src/app/pricing/BillingInterval.tsx`: toggle hidden for a workspace already on Pro (Checkout would 409); `PricingCta.tsx` dead `/already/` catch removed; pricing and `/credits` copy carry the yearly caveat; `CreditsPurchaseClient.tsx` treats yearly Pro as a pack buyer.
- Small fixes from the audit: `cronSchedule.ts` stray space, `preflight/env.ts` multi-host URI, `scripts/preflight-env.ts` `exit()`, `imageImportClosure.test.ts` posix paths, `noEmDashes.test.ts` escape pre-check, `visitBriefs.ts` topic split on " · ", `COMMANDS.md` `npm test` row.
- Still open from the audit (other agent's area, not touched): `.gitignore` re-ignoring `.env.example` (uncommitted hunk, drop it), the `DEPLOY.md` runbook pass (issue 7), `spend/route.ts` `isPro` field, `CreditsSummaryCard` dead end for yearly (folded into 1.2), realtime 40573 grace, `pro-price` route `usage_type` check. Files: `src/lib/billing/stripeSubscriptionCancel.ts` (new), `src/lib/billing/subscriptionState.ts` (`isOpenStatus`, `hasOpenSubscription`), `src/app/api/orgs/[orgId]/route.ts`, `src/app/api/account/delete/route.ts` (also fixes the phantom `isShared` write and scopes legacy docs), `src/app/api/stripe/checkout/route.ts`, `src/app/api/stripe/webhook/route.ts`, `src/app/dashboard/BillingInvoicesTab.tsx`, `src/lib/activity/{log,labels}.ts` and `mcp/src/tools/discover.ts` (new `plan.subscription_ending` event), `tests/lib/stripeWebhook.test.ts` (new, 10 cases), `package.json` (`test`), `.github/workflows/test.yml` (new), `docs/SUBSCRIPTION.md`, `docs/TESTS.md`. Manual Stripe test-mode checks (the acceptance lines below) are still to be run by hand.

### 0.1 Cancel Stripe on workspace delete — S
- `src/app/api/orgs/[orgId]/route.ts:160-172`
- Before the soft-delete, load the workspace's `SubscriptionModel` row; if `stripeSubscriptionId` is set, call `stripe.subscriptions.cancel(id)` and `$set: { isDeleted: true }` on the row. If Stripe fails, refuse the delete with 502 and leave the org intact.
- Accept: delete a Pro workspace in Stripe test mode; the subscription shows canceled in the Stripe dashboard within the same request.

### 0.2 Cancel Stripe on account deletion request — M
- `src/app/api/account/delete/route.ts:60-99`, `src/lib/accounts/purge.ts:277-300`
- On the deletion request (not the 30-day purge), for every subscription whose `stripeCustomerId` was created for this user, set `cancel_at_period_end: true`. For shared workspaces where the leaver is the only owner or admin, refuse deletion with a message to transfer ownership first.
- Accept: a Pro owner requests deletion; Stripe shows "cancels at period end"; no further invoice is generated.

### 0.3 Block checkout while a subscription is non-terminal — S
- `src/app/api/stripe/checkout/route.ts:147`
- Extend the guard from `isBillableSubscription` to any status in `{active, trialing, past_due, unpaid, incomplete}` and return the existing 409 with `portalUrl`.
- `src/app/api/stripe/webhook/route.ts:420-429`: when the row already stores a `stripeSubscriptionId`, ignore `customer.subscription.*` events whose `sub.id` differs and log them at debug level.
- Accept: force a test subscription to `past_due` with a failing card; the Upgrade button now routes to the portal; a stale event for a different subscription id does not touch the row.

### 0.4 Fix the webhook out-of-order path — S
- `src/app/api/stripe/webhook/route.ts:471-495`
- Read the row first; upsert only when none exists. When the ordered filter matches nothing, return the existing "ignored out-of-order" result instead of hitting the unique index.
- Accept: replay an older `customer.subscription.updated` after a newer `deleted`; the handler returns 200 and the row is unchanged.

### 0.5 Restore the Free daily brake on downgrade — S
- `src/app/api/stripe/webhook/route.ts:651-660` (`deleted` handler) and the `!billable` branch near `:516-520`
- `$set: { dailyCreditCap: FREE_DAILY_CREDIT_CAP }` on `WorkspaceCreditBalance` unless a pack purchase lifted it (check `purchasedCredits > 0` or the field the pack path sets).
- Accept: cancel a Pro subscription in test mode; `/api/billing/spend` shows the daily cap back at 15.

### 0.6 Invoices tab cold load — S
- `src/app/dashboard/BillingInvoicesTab.tsx:719`
- Add `canManageBilling` to the effect deps.
- Accept: hard-reload `/dashboard?tab=billing` as an owner; invoices render without visiting Overview first.

### 0.7 Webhook tests and a `test` script — M
- New `tests/lib/stripeWebhook.test.ts`: mock `constructEvent` and the models; pin duplicate-event ack, failed-first-attempt retry, out-of-order ignore, and (after 0.3) foreign-subscription-id ignore.
- `package.json`: add `"test"` running the lib, credits and upload vitest configs (not `tests:agent:vitest`).
- `.github/workflows/test.yml`: run `npm test` on pull requests.
- Accept: CI is green on main and red when any of the four webhook invariants is broken on purpose.

---

## Phase 1 — Route every wall to the right door (copy and routing, no pricing change)

All of these are client-side or copy. Ship as one PR or several; none depends on another.

**Status 2026-09-24: done, uncommitted.** 1.1–1.7 implemented by six bundle agents, each reviewed through a correctness and a conformance lens and fixed in place; `tsc`, `npm run lint` and `npm test` pass. Adjustments from the yearly-Pro audit were applied: the out-of-credits modal, the blocked banner, the sidebar row and the Credits summary card all route yearly Pro to `/credits` like Free (interval read from `/api/billing/status`, keyed to the workspace, with the primary action disabled until the read lands so nobody is sent to the on-demand page that refuses yearly). Notes: (1.3) the live create-workspace call is in `src/app/dashboard/WorkspaceManager.tsx`, not `TeamsManager.tsx`; both WorkspaceManager copies got the 402 handling and the preferences copy's infinite-fetch bug is fixed (the route is still reachable, so it was not deleted); when the *active* workspace is Pro the per-account team-workspace refusal shows the server message inline instead, since the upgrade modal refuses to open on Pro. (1.4) the brief card's button is only reachable when the plan changed mid-session, because the brief list itself 402s on Free. (1.5) `DocMetricsModal.tsx` was orphaned and is deleted. (1.6) the grace countdown on the home upload notice is now derived from the plan snapshot's `graceActive`, since a blocked notice and a grace hint were mutually exclusive by construction. (1.7) the Free view email's secondary button goes to the doc metrics teaser when the primary went to the reader page, else `/pricing`, always with `from=view_email`; `tests/lib/viewNotifications.test.ts` pins it. `docs/FEATURES.md` and the sidebar fallback nudge (secondary action for the two new limit keys) were updated by the orchestrator.

### 1.1 Out-of-credits modal: pack first on Free — S
- `src/components/OutOfCreditsModal.tsx:37-89`
- Free "starter credits used" variant: primary **Buy 75 credits for $7** (route to `/credits`), secondary **Upgrade to Pro**, tertiary Not now. Read the cheapest pack from `CREDIT_PACKS` via `formatPackPrice`, never retype the number.
- Free "daily cap" variant: add the sentence "A credit pack lifts the daily cap" (true per `purchases.ts:102`) and the same two buttons.
- Accept: exhaust starter credits on a Free workspace; the modal offers the pack first and the link lands on `/credits`.

### 1.2 Blocked banner and sidebar: same routing — S
- `src/app/dashboard/dashboardShell.tsx:300-330`, `src/components/SidebarCredits.tsx:83-88`
- Free banner CTA becomes **Add credits** → `/credits` with **or upgrade to Pro** as a text link. Sidebar "Out of AI credits" → `/credits` on Free, `/dashboard/limits` on Pro.
- Also fix the stale-closure bug that hides the banner after a realtime event (`dashboardShell.tsx:152-221`): read `activeOrgId`/`orgReady` through refs inside `refreshCredits`.
- Accept: with the banner showing, save AI quality defaults; the banner stays.

### 1.3 Team-workspace cap gets the modal — S
- `src/app/preferences/WorkspaceManager.tsx:212`, `src/app/dashboard/TeamsManager.tsx` (the live copy)
- Add `team_workspaces` to `LIMIT_KEYS` in `src/lib/client/planLimit.ts` and a registry entry in `src/lib/client/upsellCopy.ts` ("Free accounts can have one team workspace"). On 402, call `openUpgrade`.
- Delete `src/app/preferences/WorkspaceManager.tsx` if `/preferences` is retired (the code review found it is a stale copy with an infinite-fetch bug); otherwise apply the same fix there.
- Accept: create a second team workspace on Free; the upgrade modal appears with the right copy.

### 1.4 Visit-brief wall gets a button — S
- `src/lib/client/planLimit.ts` (add `visit_briefs` to `LIMIT_KEYS`), `src/lib/client/upsellCopy.ts` (entry: "Visit briefs are a Pro feature"), `src/components/metrics/VisitBriefCards.tsx:107-108`
- Replace the plain sentence with `PlanLimitNotice` carrying an **Upgrade** button.
- Accept: on Free, the brief card shows a button that opens the modal.

### 1.5 Remove or gate `DocMetricsModal` — S
- `src/components/modals/DocMetricsModal.tsx`
- The code review found it orphaned. Delete it and its import sites. If it is still reachable, gate the range picker and viewer list on `analyticsTier === "deep"` and show the deep-analytics teaser otherwise.
- Accept: no Free surface shows a 30-day range or "No authenticated viewers yet."

### 1.6 Fix hard-coded caps and stale copy — S
- `src/app/HomeAuthedClient.tsx:349`, `src/app/(app)/upload/pageClient.tsx:243`, `src/app/(app)/doc/[docId]/pageClient.tsx:2822`: replace `?? 3` with `FREE_DOCUMENTS` imported from `src/lib/billing/planLimits.ts` (or the client-safe constant module the pricing page uses).
- `src/app/(app)/doc/[docId]/history/pageClient.tsx:1032`: remove "Tops up to 10 on {date}"; show "Pro includes 500 a month" or nothing.
- `src/app/HomeAuthedClient.tsx`: pass `graceHint` to the upload-cap notice so the grace countdown appears there as it does elsewhere.
- Accept: grep for `?? 3` in those three files returns nothing; the history page never mentions a top-up.

### 1.7 Free view-notification emails get a button — S
- `src/lib/notifications/viewNotifications.ts:88-90, 810-813`
- Replace the unlinked "Pro shows who opened it and how long they stayed" with a rendered button **See who opened it** → `/pricing?from=view_email` (or the doc metrics page, which shows the teaser). Keep the sentence as the button's caption.
- Accept: send a test view email for a Free workspace (`npm run test:emails`); the button renders and the link carries the `from` param.

---

## Phase 2 — Show the real thing (analytics teaser with real data)

The single highest-leverage conversion change. Identities are already recorded on Free; the teaser just has to stop lying.

**Status 2026-09-25: 2.1 and 2.2 done, Option A of 2.3 taken.** `src/lib/analytics/teaser.ts` computes `{ uniqueViewers, identifiedViewers, firstViewAt, hiddenDays }` over the route's own scope with no window and projects nothing but numbers and a date; the document and project shareviews routes send it on the basic tier only. `MetricsView` replaces the three blurred rows with the sentence and one skeleton row. Live on the dev workspace flipped to Free: 20 unique / 9 identified, equal to a manual Mongo count. `tests/lib/analyticsTeaser.test.ts`. Options B and C stay open for Phase 5.

### 2.1 Server: return the real unique count and first-view date on Free — M
- `src/app/api/docs/[docId]/shareviews/route.ts:298-302, 1074-1078`
- On the basic tier, alongside the empty `viewers: []`, return `teaser: { uniqueViewers, identifiedViewers, firstViewAt, hiddenDays }` computed over full history (not the 7-day clamp), where `identifiedViewers` is the count of rows with an email or verified identity. Never return names, emails, companies or per-page data.
- Add the same fields to the workspace metrics and project shareviews routes if they have a basic-tier branch.
- Accept: unit test in `tests/lib` asserts the basic-tier payload has counts, dates, and no identity fields.

### 2.2 Client: replace blurred fake rows with the real numbers — M
- `src/components/metrics/MetricsView.tsx:894-996`, `src/components/metrics/QuickStats.tsx:551-566`, `src/components/metrics/Sections.tsx:226-230`, `src/components/metrics/RangeControl.tsx:38-56`
- Teaser copy: "**{identifiedViewers} named people** and {uniqueViewers − identifiedViewers} anonymous readers opened this since {firstViewAt}. Pro shows who they were, how long they spent on each page, and everything since day one." One **Upgrade to Pro** button (opens the modal with reason `analytics_history`) and a smaller "See what's included."
- When `identifiedViewers === 0`, fall back to the count-only line; when both are 0, show the existing empty state.
- Keep one row of skeleton chrome under the copy so the layout does not jump on upgrade.
- Accept: on a Free workspace with recorded views, the numbers match a manual count in Mongo.

### 2.3 Decide and ship one "taste" mechanic — M (decision first)
- Option A, retroactive reveal only (2.1 and 2.2, nothing more).
- Option B, reveal one real viewer name (no company, no pages) on Free per document.
- Option C, per-document unlock: "See who read this deck: 5 credits" on Free, spending starter or pack credits; implement as a `docAnalyticsUnlockedAt` field checked alongside `analyticsTier`.
- Recommendation: ship A now; add C in Phase 5 if the funnel shows repeat pack buyers who never upgrade.

---

## Phase 3 — Pricing changes

### 3.1 Confirm annual Pro is live — S (config)
- Set `STRIPE_PRICE_ID_ANNUAL` in production to the `pro_annual` price from `docs/SUBSCRIPTION.md:137`.
- Verify `/pricing` shows the month/year toggle and checkout with `interval: "year"` succeeds in test mode.
- Update the pricing FAQ to state the trade-off already in the docs: annual workspaces buy packs instead of on-demand.
- Accept: a test annual checkout results in `Subscription.interval === "year"` and a 500-credit grant for month 1.

### 3.2 Seat SKU replaces "Contact us" — L
- Stripe: create a recurring `STRIPE_SEAT_PRICE_ID` at $5/seat/month (and an annual twin if annual is live).
- `src/lib/models/Subscription.ts`: add `licensedSeats: number`.
- `src/app/api/stripe/webhook/route.ts`: on `customer.subscription.created/updated`, read the seat item quantity into `licensedSeats`.
- `src/lib/billing/planLimits.ts:163-170, 357-359`: collaborators allowed = `PRO_INCLUDED_COLLABORATORS + licensedSeats`; on overflow return 402 with `limit: "collaborators"` and a new `addSeatUrl`.
- New `POST /api/stripe/seats` (owner/admin): update the subscription's seat item quantity with proration, or redirect to the portal's update-quantity flow if simpler.
- `src/app/dashboard/TeamsManager.tsx:776-788`: replace **Contact us** with **Add a seat for $5/month** calling the new route; show "N of M seats used."
- `src/app/api/org-invites/claim/route.ts:167-182`: re-count after the membership write and roll back when over the cap (fixes the concurrent-claim overflow).
- `docs/prds/lnkdrp-plan-limits.md` M2 is the spec; update it with what shipped.
- Accept: a Pro workspace with 3 collaborators invites a 4th; the UI offers the seat; after purchase the invite succeeds and Stripe shows quantity 1 on the seat item.

### 3.3 Fix the credit-rate inversion — S
- Pick one:
  - Let Pro buy packs: remove the 409 at `src/app/api/credits/purchase/route.ts:85-96` and the "Pro workspaces see no packs" branch in `src/app/credits/CreditsPurchaseClient.tsx:454-473`; keep the on-demand card beside the packs. Update `packs.ts` header comment.
  - Or lower on-demand: `USD_CENTS_PER_CREDIT = 8` in `src/lib/billing/pricing.ts:10`, update the Stripe metered price, `CREDITS_COPY.perCreditUsd`, `/pricing` copy, and Terms §8.
- Recommendation: let Pro buy packs. It is one deletion, and annual workspaces already need it.
- Accept: a Pro workspace completes a pack checkout; `purchasedCredits` increases and consumption order still prefers subscription credits.

### 3.4 Branding as a loop and an SKU — M (product decision to reverse first)
- `src/components/BrandHeader.tsx` documents the unlinked logo as intentional. Reverse that decision explicitly in the PRD before coding.
- `src/app/s/[shareId]/page.tsx`, `src/app/p/[shareId]/**`: pass `logoHref="/?ref=share"` on recipient pages.
- New footer line on recipient pages for Free-owned links only: "Sent with LinkDrop · Send your own PDFs and see who reads them" linking to `/?ref=share_footer`. Read the owner plan through the existing `ownerPlan` helper in `src/lib/share/ownerPlan.ts`.
- `src/lib/billing/planLimits.ts`: add feature gate `branding` (Pro removes the footer; logo stays on all plans).
- `src/app/pricing/page.tsx`: add "No LinkDrop footer on your links" to the Pro list.
- Accept: a Free-owned share page shows the footer; a Pro-owned one does not; both logos link home.

### 3.5 Record real AI cost per run — M
- `src/lib/models/CreditLedger.ts:61-74` already has `costUsdActual`; nothing writes it.
- Add a small price table (`src/lib/ai/modelPricing.ts`: input/output/image token prices per model, dated) and write `costUsdActual` from the provider usage object in every AI call site (`analyzePdfText`, `docChangeDiff`, `visitBrief`, `reviewDocText`).
- Add an admin view or a script (`scripts/credits-margin-report.ts`) grouping ledger rows by `actionType` and tier: credits charged, USD cost, implied margin.
- Accept: after ten test runs, the report shows non-zero cost for every action type.

---

## Phase 4 — Instrument the funnel

Do this before Phase 5 decisions. Small change, since `recordActivity` and the 402 contract already exist.

### 4.1 Emit funnel events — S
- Server: in `planLimitResponse` (`src/lib/billing/planLimits.ts:397-421`), `void recordActivity({ type: "plan.limit_hit", meta: { limit, used, max, grace } })`.
- Client: in `UpgradeModalProvider` and `OutOfCreditsListener`, `POST /api/activity` (or a new lightweight `POST /api/funnel`) with `modal_shown`, `cta_clicked: upgrade|pack|compare|dismiss`, `reason`, and `from` (the surface). In checkout and pack-purchase routes, record `checkout_started` with `interval`/`pack`; the webhook already records `plan.upgraded`.
- Accept: `ActivityEvent` rows exist for each step of one manual upgrade.

### 4.2 Admin funnel page — M
- `src/app/a/funnel/page.tsx` (admin-gated like the rest of `/a`): per week, count workspaces at each step, split Free → pack vs Free → Pro, median days from signup to first wall, which `limit` key fires first, and viewer count at the moment the analytics teaser was shown.
- Accept: the page renders for the last 8 weeks without a full-collection scan (use the activity keyset index).

---

## Phase 5 — Decide after 60 days of data

Not scheduled. Each is a one-page decision with the data from Phase 4.

- **Trial**: if Free → Pro conversion after Phase 2 is under 3% of workspaces that saw the teaser, add a 7-day card-required trial (`trial_period_days` in checkout; `trialing` is already honored).
- **Per-document unlock** (2.3 option C): if repeat pack buyers who never upgrade exceed 20% of pack revenue.
- **Free document cap**: if most upgrades come from the analytics wall, leave 10. If most come from the document wall and pack revenue is small, consider 5.
- **Middle tier at $12**: only if the funnel shows a large population buying packs monthly and bouncing off $29. Otherwise do not add a tier.

---

## Phase 6 — Documentation and comment drift

One PR, mechanical. Everything here contradicts the code.

**Status 2026-09-25: done**, except `credits/purchase/route.ts:50` ($39 in a comment; the file was in another agent's hands, left for them) and `BillingConfig.ts` / the creditPacks narrative, which had already been fixed. The `/pricing` credit table is generated from `COST_CATALOG`; "Verified access for sensitive links" is off the Enterprise card; `brief` rows label as "Visit brief" on the billing tab; the Pro price label falls back to Stripe (`src/lib/billing/proPriceFromStripe.ts`, cached an hour) when the admin has never stored one, so "price shown at checkout" only appears when Stripe itself is unreachable.

- `docs/SUBSCRIPTION.md:60`: team workspaces on Free do get 100 starter credits.
- `docs/prds/lnkdrp-credit-features.md:9,45`: 100 starter / 500 Pro / no monthly top-up.
- `docs/prds/lnkdrp-plan-limits.md:9`: 10 documents / 2 projects / 3 collaborators.
- `docs/FEATURES.md:19,77`: 3 collaborators; the meter counts documents, not links.
- Comments: `creditService.ts:33,82` (50 → 100), `subscriptionState.ts:10` (300 → 500), `credits/purchase/route.ts:50` ($39 → $37), `BillingConfig.ts:14` ($20/mo example), `StripePricingTable.tsx` (keys on `orgId`, not `userId`).
- `src/lib/billing/usageAggregation.ts:10`: add `"brief"` to `actionType` so billing-tab rows stop reading "Unknown".
- `src/app/pricing/page.tsx:276-281`: generate the credit-cost table from `costCatalog.ts` instead of literals.
- `src/app/pricing/page.tsx:349`: drop "Verified access for sensitive links" from the Enterprise card until the link-access PRD ships.
- Pro price display: read the licensed price from Stripe at build time or cache it hourly in `src/lib/billing/proPriceLabel.ts` so `/pricing` never shows "price shown at checkout."
- `tests/credits/creditPacks.test.ts:10,50`: update the narrative to the current 2900/500 numbers.

---

## Suggested sequencing

| Week | Ship |
|---|---|
| 1 | Phase 0 (all), Phase 1.1–1.7 |
| 2 | Phase 2.1–2.2, Phase 3.1, Phase 3.3, Phase 4.1 |
| 3–4 | Phase 3.2 (seats), Phase 3.4 (branding), Phase 6 |
| 5 | Phase 3.5, Phase 4.2 |
| Day 60 | Phase 5 decisions |

Phase 0 and Phase 1 are about eleven small tasks and can be one focused week. Nothing in Phase 3 should ship before Phase 0.3 and 0.4, because seats and packs both add subscription and webhook traffic.
