# Session summary — 2026-09-23 to 2026-09-24

What was asked, what was delivered, and what is left. All code changes are in the working tree on branch `next-release`, **uncommitted**. Nothing was pushed.

## Deliverables

| Document | What it is |
|---|---|
| `docs/reviews/full-code-review-2026-09-23.md` | Whole-codebase review (~91k lines, eight parallel reviewers): 10 high, 35 medium, ~50 low findings with file:line, plus a suggested order of work. |
| `docs/reviews/pricing-upsell-analysis-2026-09-23.md` | Pricing model as implemented, unit economics, competitive frame, where money is being left, recommendations by horizon. |
| `docs/reviews/pricing-upsell-fix-plan-2026-09-23.md` | Six-phase plan with files, changes and acceptance checks per task; status lines updated as phases shipped. |
| `docs/reviews/agent-overlap-audit-2026-09-24.md` | Audit of the other agent's commits against the plan and the review: what overlaps, what is good, what to fix. |
| This file | Session summary. |

## Code shipped

### Phase 0 — money safety (7 tasks)
- Workspace delete cancels the Stripe subscription first (502 and no delete if Stripe fails); yearly subscriptions are cancelled with proration.
- Account deletion sets cancel-at-period-end on subscriptions nobody else could manage, and posts a `plan.subscription_ending` activity row (a "replace the card" variant where another admin remains). Fixed the phantom `isShared` write and scoped legacy documents.
- Checkout refuses a second subscription while one is open in any non-terminal status, with a same-origin redirect to the Billing tab.
- Webhook ignores events for a subscription the workspace no longer tracks, handles out-of-order events quietly instead of 400 + three days of retries, restores the Free daily brake on downgrade and lifts it on recovery.
- Invoices tab loads on a cold visit.
- New `tests/lib/stripeWebhook.test.ts` (12 cases), `npm test` umbrella script, `.github/workflows/test.yml`.

### Phase 0.8 — yearly Pro interactions (from the audit)
- Credit service on-demand gate reads the interval; yearly rows never allocate on-demand credits.
- Webhook nulls the metered item id and turns on-demand off on yearly.
- Purge skips subscriptions already set to end at period end (no forfeiture of a prepaid year).
- Interval toggle hidden for a workspace already on Pro; dead 409 catch removed; pricing and credits copy carry the yearly caveat; purchase panel treats yearly Pro as a pack buyer.
- Seven small fixes in the other agent's commits (cron board copy, multi-host Mongo URI preflight, script exit helper, a vacuous Windows test, em-dash test skipping escapes, visit-brief topic split, COMMANDS.md).

### Phase 1 — route every wall to the right door (7 tasks)
- Out-of-credits modal, blocked banner, sidebar credits row, Credits summary card: pack first on Free; yearly Pro routed to `/credits`, never to the on-demand page.
- Stale-closure bug that hid the blocked banner fixed.
- Team-workspace cap and visit-brief wall open the upgrade modal; preferences copy's infinite fetch fixed.
- Orphaned `DocMetricsModal.tsx` deleted; hard-coded document caps replaced with the constant; "tops up" copy removed; home upload notice shows the grace countdown.
- Free view emails carry a "See who opened it" button (new `tests/lib/viewNotifications.test.ts`).
- Sidebar fallback nudge and `docs/FEATURES.md` updated to match.

## Verification (final state)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors |
| `npm test` (lib, credits, upload) | 2,791 passed, 7 skipped |
| `npm run index` | regenerated, 896 files |

Not run: the Stripe test-mode manual checks in the plan's acceptance lines (delete a Pro workspace, force past_due then Upgrade, replay a stale event, yearly checkout).

## The other agent

Works on the same checkout and commits to `next-release`. Their commits: yearly Pro billing, an em-dash sweep with an AST test, Mongo access diagnostics, realtime boot check, Windows exit helper, COMMANDS.md. One commit absorbed my checkout, webhook and subscription-state hunks unchanged. Their work is sound; the gaps are in the audit. Still theirs to handle:
- Uncommitted `.gitignore` hunk re-ignores `.env.example` (drop it).
- `DEPLOY.md` runbook: eight stale lines (audit issue 7).
- `src/app/api/billing/spend/route.ts` reports yearly Pro as `isPro: false`.
- Realtime 40573 grace and the wrong-database explanation for a missing `changeStream` role.
- `pro-price` admin route accepts a metered yearly price.

## Not started

- **Phase 2**: real-count analytics teaser (adds fields to the share-views API, replaces the blurred fake rows). Highest-leverage conversion change; needs a go because it changes a payload.
- **Phase 3**: confirm `STRIPE_PRICE_ID_ANNUAL` in production; seat SKU; credit-rate inversion decision (let Pro buy packs vs 8¢ on-demand); branding footer as a loop and an SKU; record real AI cost per run.
- **Phase 4**: funnel instrumentation and an admin funnel page.
- **Phase 5**: decisions after 60 days of data (trial, per-document unlock, Free cap, middle tier).
- **Phase 6**: documentation drift (nine places docs and comments contradict the code).
- The code review's non-pricing findings (upload secret never expiring, MCP body guard bypass, request-repo delete mode, usage reconcile window, and the frontend dead-ends) are untouched; the review's order-of-work section lists them.

## Commit guidance

Two agents share this tree. Suggested split when committing: `billing:` for Phase 0 and 0.8 (new files `stripeSubscriptionCancel.ts`, `stripeWebhook.test.ts`, `.github/workflows/test.yml`, `package.json`, the webhook/checkout/account/orgs routes, `serviceCore.ts`, `purge.ts`, pricing/credits copy), `ui:` for Phase 1 (modal, banner, sidebar, summary card, limit keys, the four pageClients, `viewNotifications.ts` and its test, the deleted modal), `docs:` for the five review files and the doc edits. `INDEX.md` goes with whichever lands first.
