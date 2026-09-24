# Pricing and upsell analysis — 2026-09-23

Grounded in what the code enforces and displays today (constants in `src/lib/billing/planLimits.ts`, `src/lib/credits/{grants,packs,schedule}.ts`, `src/lib/billing/pricing.ts`, the `/pricing` page, and every upsell surface in `src/components` and `src/app`). Competitor figures are approximate list prices from public pricing pages and should be re-checked before quoting.

## 1. Summary

The pricing model is coherent and unusually honest: one Pro tier at $29/workspace, a generous Free tier, credits that map cleanly to AI cost, and every cap enforced server-side with a typed 402 the UI knows how to render. The machinery is better than most seed-stage products.

The money is being left in five places:

1. **The upgrade trigger is deep analytics, but Free users never see a real glimpse of it.** Identities are recorded on Free and revealed retroactively on upgrade, yet the teaser shows blurred fake rows instead of "14 real people opened this deck this week."
2. **No trial, no seat SKU, and annual may not be switched on.** Annual Pro is fully built behind an optional env var (see §4.2). Pro seat overflow ends in "Contact us."
3. **Pro pays more per marginal credit than Free** (10¢ on-demand vs 9.3¢ packs), and Pro cannot buy packs at all.
4. **There is no recipient-side loop.** Every share page is seen by more non-users than users, and none of them are given a reason or a link to sign up.
5. **The out-of-credits path routes Free users to the $29 decision instead of the $7 one**, contradicting the pricing page and the Plan card.

Plus a handful of bugs from the code review that sit directly on the checkout path (invoices never loading cold, the blocked-banner vanishing, double subscriptions on past_due).

## 2. The model as implemented

| | Free | Pro | Enterprise |
|---|---|---|---|
| Price | $0 | $29/mo per workspace | "Talk to us" |
| Shared documents | 10 | unlimited | unlimited |
| Links per document | unlimited | unlimited | |
| Project links | 1 | unlimited | |
| Projects | 2 | unlimited | |
| Collaborators (beyond owner) | 0 | 3, then "Contact us" | unlimited |
| Viewers (read-only members) | unlimited | unlimited | |
| Team workspaces owned | 1 | n/a | |
| Analytics | last 7 days, counts only | full history, identities, per-page time, visit timelines, briefs | |
| Recipients browse versions | no | yes | |
| Password / expiry / download control | yes | yes | |
| MCP / API keys | yes | yes | |
| Credits | 100 once, max 15/day | 500/cycle, no rollover | |
| Extra credits | packs: 75/$7, 150/$14, 400/$37 (9.3¢) | on-demand 10¢ under a spend cap; packs refused | |
| Annual plan | n/a | $290/yr built; live only if `STRIPE_PRICE_ID_ANNUAL` is set | |
| Trial | none | none | |

Credit costs: summary 1/2/5, compare 2/5/12, brief 1, review 2/5/12 (unreleased), recipient Q&A 1/2/5 (unreleased). Pro effective rate is 5.8¢/credit.

### Unit economics

Only one operation has a stated cost in the repo (visit brief, about 1¢ on gpt-4o). At that cost, gross margin per credit is roughly 83% on Pro included, 89% on packs, 90% on on-demand. Summary and compare costs are not recorded (`costUsdActual` is never written), and the risk case is image-bearing runs on gpt-4o with up to 45 page tiles at about 1,100 tokens each. Recommendation in §6: start writing `costUsdActual` so margin per tier is a query, not a guess.

### Competitive frame (approximate)

| Product | Entry paid | Notes |
|---|---|---|
| DocSend | ~$15/user/mo Personal, ~$45/user/mo Standard | per user, annual-billed prices |
| Papermark | ~$39/mo Pro, ~$79/mo Business | per workspace, open-source Free |
| Pitch/Google Drive | free | no viewer analytics |

At $29 per workspace with 3 collaborators, lnkdrp is priced under DocSend Standard for a 2-person team and roughly at DocSend Personal for a solo founder. The per-workspace framing is a real advantage against per-seat competitors and should be said out loud on `/pricing` ("$29 covers your co-founder and head of sales").

## 3. What is working

- **One-tier clarity.** Free vs Pro with a single price is easy to explain, and the FAQ explains the doc-not-link cap well.
- **Free is a real product, not a demo.** Passwords, expiry, download control, unlimited links, MCP access on Free means the product gets used and shared, which is where the upgrade pressure comes from.
- **Typed 402 contract.** Every cap returns `{code: "plan_limit", limit, used, max, grace, upgradeUrl}` and the modal renders it. Adding a new gate is one registry entry.
- **Grace period with three emails** for grandfathered or downgraded workspaces is a humane retention mechanic most products skip.
- **Pack ladder is designed to push to Pro.** The 400-credit pack ($37) costs more than a month of Pro ($29) for fewer credits and no analytics, and `/credits` says so.
- **Credits refund on failure, summaries are free when an agent writes them.** These build trust in the meter.

## 4. Pricing structure problems

### 4.1 Deep analytics is the upgrade reason, and Free users never see it work
Identities are stored on Free and shown retroactively on Pro. The teaser at `MetricsView.tsx:894-996` shows blurred placeholder rows. The strongest possible upsell is already true and unused: "**14 people** opened this in the last 7 days. Upgrade to see who, and everything they read since you sent it." Use the real unique count and the real "since" date. Consider revealing one real row (name only, no company or pages) as a free sample.

### 4.2 Annual plan is built but may not be live
Correction to the summary above: annual Pro is implemented end to end. Checkout accepts `interval: "year"` and uses `STRIPE_PRICE_ID_ANNUAL`, the pricing page has a month/year toggle (`src/app/pricing/BillingInterval.tsx`), the upgrade modal and Plan card know about it, the grant code splits the year into monthly credit windows, and `docs/SUBSCRIPTION.md` lists a $290 price. The env var is optional and "unset = monthly only," so the only work is confirming it is set in production. Note the trade-off already documented: annual workspaces carry no metered item, so they cannot use on-demand and buy packs instead.

### 4.3 No trial
Free is the trial for everything except the thing that sells Pro. Options, in order of preference:
- **Retroactive reveal** (§4.1) is a zero-risk trial of the data itself.
- **7-day Pro trial with card** via Stripe `trial_period_days`; the code already honors `trialing`.
- **Per-document unlock**: "See who read this deck: 5 credits" as a metered micro-purchase on Free. Unusual, but it converts credits into an analytics taste and works with the pack ladder.

### 4.4 Seats end in a wall
Pro includes 3 collaborators; the 4th gets "Contact us." The PRD already specifies `STRIPE_SEAT_PRICE_ID` at $5/seat/month. Ship it. A team that hits this wall has already paid and already invited; "Contact us" on a self-serve product loses some of them.

### 4.5 Pro pays more per marginal credit than Free
Packs are 9.3¢, on-demand is 10¢, and Pro cannot buy packs (409 `PACKS_FREE_ONLY`). The inversion is small but backwards. Either let Pro buy packs (simplest, and packs expire in 12 months so the risk is bounded) or price on-demand at 8¢ so the ladder reads Free pack 9.3¢, Pro on-demand 8¢, Pro included 5.8¢.

### 4.6 No branding lever
Every share page shows an unlinked LinkDrop logomark and no footer. This is a missing viral loop (§5) and a missing SKU: "remove LinkDrop branding" is a standard Pro or Enterprise line item and costs nothing to build. Do not remove branding from Free; link it.

### 4.7 Free might be one notch too generous
10 documents with unlimited links, unlimited viewers, all link controls, and MCP access covers a fundraise end to end. This is defensible as a growth choice if the analytics teaser converts, and a mistake if it does not. Do not change the number now; instrument the funnel (§6) and revisit after 60 days of data. If the cap ever moves, 5 is the number where a two-deck fundraise still fits but a sales team does not.

## 5. Upsell funnel problems

### Broken or missing paths
1. **Out-of-credits modal offers only Pro** (`OutOfCreditsModal.tsx:37-89`). Free users who just want to finish a compare should see "Buy 75 credits for $7" first and Pro second. The daily-cap variant should say a pack lifts the cap, which is true and is what `/credits` says. The dashboard blocked banner has the same problem (sends to `/pricing`, not `/credits`).
2. **Team-workspace cap is plain red text** (`WorkspaceManager.tsx:212`), no modal, no link.
3. **Visit-brief manual write** returns a 402 the client does not recognise; `VisitBriefCards.tsx:107` shows "Briefs are written on Pro." with no button.
4. **DocMetricsModal is ungated** and shows a 30-day picker and "No authenticated viewers yet" on Free, which reads as "nobody viewed it" instead of "upgrade to see."
5. **Free view-notification emails** carry "Pro shows who opened it" as unlinked text. This is the highest-intent moment in the product (someone just opened your deck) and it has no button.
6. **Pro seat overflow → Contact us** (§4.4).
7. **Hard-coded fallback caps** (`?? 3` in three places) will show wrong numbers when the plan snapshot is slow; `FREE_DOCUMENTS` is 10.
8. **History page says "Tops up to 10 on {date}"**, which no longer exists.

### Recipient side: no loop
- Logo is unlinked on `/s` and `/p` pages (linked only on `/r`).
- No "get your own link" anywhere a recipient looks, except buried in the Introduce Yourself modal's "Or use a free lnkdrp account."
- OG image has no logo; unfurl fallback is "Shared with LinkDrop."
- The only account-creating flow is the download-request path.

DocSend and Papermark both convert recipients. Minimum viable loop: link the logomark to `/?ref=share`, add a one-line footer "Sent with LinkDrop · Send your own PDFs and see who reads them" on Free-owned links only, and make "remove branding" a Pro feature. That turns the branding into both a loop and an SKU.

### Bugs from the code review that sit on the purchase path
- Invoices never load on a cold Billing tab (`BillingInvoicesTab.tsx:719`).
- Out-of-credits banner disappears after any realtime event (`dashboardShell.tsx:152-221`).
- Checkout can mint a second subscription while the first is past_due, then the webhook flips between them (`checkout/route.ts:147`, `webhook/route.ts:420`).
- Deleting a workspace or an account leaves Stripe billing (`orgs/[orgId]/route.ts:160`, `account/delete/route.ts:60`). This one is a refund and a chargeback waiting to happen.
- Downgrade from Pro never restores the 15/day Free brake, so a lapsed Pro can burn remaining credits with no cap.

## 6. Recommendations

### Do this week (copy, routing, no pricing change)
- Out-of-credits modal and blocked banner: pack first, Pro second, both variants. Mention that a pack lifts the daily cap.
- Replace blurred fake rows with the real unique-viewer count and real dates. Add the same line to Free view emails with an **Upgrade** button.
- Link the share-page logomark. Add the Free-only footer line.
- Modal for the team-workspace cap; button on the brief-card message; gate `DocMetricsModal` or remove it (the review found it orphaned).
- Fix the `?? 3` fallbacks and the "Tops up" copy.
- Fix the four purchase-path bugs above, starting with subscription cancellation on workspace and account deletion.

### Do this month (pricing changes)
- **Confirm annual Pro is live**: set `STRIPE_PRICE_ID_ANNUAL` in production and check the toggle renders on `/pricing`. Everything else is already built.
- **Seat SKU at $5/seat/month** replacing "Contact us." The PRD is written.
- **Fix the credit rate inversion**: let Pro buy packs, or drop on-demand to 8¢.
- **Branding removal as a Pro feature** (pairs with the footer above).
- Start writing `costUsdActual` on every ledger row so margin per tier and per operation is queryable. Until then the image-heavy summary and compare runs are unpriced risk.

### Decide after data (60 days)
- Whether to add a Pro trial (7 days, card required) or rely on the retroactive reveal.
- Whether Free at 10 documents is the right notch (§4.7).
- Whether a middle tier is needed. Today the jump is $0 → $29. If the funnel shows many Free users buying packs repeatedly and never upgrading, a **$12/mo "Solo"** with deep analytics on 3 documents and 150 credits would catch them; if it shows Free → Pro converting fine, do not add one. Do not add a tier until the data says so.

### Instrument before changing anything else
Track, per workspace: first 402 by limit key, modal shown → CTA clicked → checkout started → paid, pack bought vs Pro, days from signup to first paywall, and viewer-count at the time the analytics teaser is shown. The `plan_limit` 402 and the modal already exist; emitting an activity row for each is a small change. Without this, every question in this document stays an opinion.

## 7. Documentation drift to fix

The pricing page reads its numbers from code, so it is right. The docs are not:
- `docs/SUBSCRIPTION.md:60` says team workspaces on Free get no credits; code grants 100.
- `docs/prds/lnkdrp-credit-features.md` says 50 starter / 300 Pro / monthly top-up; code is 100 / 500 / none.
- `docs/prds/lnkdrp-plan-limits.md:9` says 3 links / 1 project / 1 collaborator; code is 10 docs / 2 projects / 3.
- `docs/FEATURES.md:19,77` says 1 collaborator and "Links x of 10"; the cap counts documents.
- Stale code comments: "50-credit starter" (`creditService.ts:33,82`), "300 included" (`subscriptionState.ts:10`), "$39 charge" (`credits/purchase/route.ts:50`), "$20/mo" example (`BillingConfig.ts:14`).
- `usageAggregation.ts:10` lacks `"brief"`, so brief rows show as "Unknown" on the billing tab.
- `/pricing` credit-cost table is hand-typed and duplicates `costCatalog.ts`.
- Enterprise card says "Verified access for sensitive links," a feature whose PRD is deferred.
- Pro price is not read from Stripe; `/pricing` shows no number unless an admin sets `proPriceLabel`. Read it from the Stripe price object at build or cache it hourly.
