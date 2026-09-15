# PRD — Plan limits and collaborator seats (pre-launch enforcement)

**Status:** Draft (v1)
**Owner:** chrissanz
**Last updated:** 2026-09-12
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-mcp](./lnkdrp-mcp.md) · [lnkdrp-credit-features](./lnkdrp-credit-features.md) · [SUBSCRIPTION](../SUBSCRIPTION.md) · [FEATURES](../FEATURES.md)

> **Decision (2026-09-12).** The pricing page and Terms §8 now describe Free (3 active links, 1 project,
> 7 days of analytics, no collaborators) and Pro (unlimited, 1 collaborator included, more on
> request; paid seats deferred). Free limits and the 14-day grace are enforced (M1 shipped). Seat pricing must not be announced until it is enforced and billable.

---

## Problem

(Resolved by M1; kept for context.) The site promised plan limits the app did not enforce. A Free workspace today can share unlimited
links, create unlimited projects, invite anyone, and see all analytics. The dashboard still shows an
"AI Credits" counter and Usage tab that no longer mean anything at launch.

## Goal

Make the app match the pricing page: enforce Free limits with clear upgrade prompts (web and MCP),
bill collaborator seats through Stripe, and hide the credit UI until a metered feature ships.

## Proposed decisions (to lock)

1. **Active link** = a Doc with `shareEnabled: true` and not deleted. Disabling sharing frees the slot.
   *(Note, 2026-09-15: this definition is the proof that the cap was always on **documents** — an
   "active link" here is a Doc, not a `sharelinks` row. The multi-links work later counted link rows
   against it, which is how a two-document workspace read "11 of 3". The code says `documents` now
   so the name cannot be misread that way again.)*
2. **Limits are per workspace** and read from one constants module shared by the pricing page.
3. **Starter credits are granted once per user** (personal workspace), not per new workspace.
4. **Seats count people, not agents.** Owner + 1 collaborator free; each further member is a Stripe seat line item with quantity, prorated.
5. **Grandfather** any existing workspace over the limits at rollout; enforce only on new links/invites.

## Approach

Enforcement lives in the service layer so web routes and MCP tools share it. Each limit returns a
typed `plan_limit` error carrying `{limit, current, upgradeUrl}` so the agent can explain it.

### Grace period

A Free workspace that is already over a limit (grandfathered at rollout, or pushed over by a
downgrade / a member joining) is not blocked on the spot. An hourly cron
(`/api/cron/plan-limits`, `src/lib/billing/planGrace.ts`) starts a 14-day window
(`LIMIT_GRACE_DAYS`) recorded on `Org.planGrace = { startedAt, endsAt, blockedAt, remindersSent }`,
emails the workspace owners when it starts, again on day 7 and day 12, and sets `blockedAt` when it
ends. Inside the window `checkLimit()` still allows creates and returns a `warning`; after
`blockedAt` it returns `402 plan_limit`. Existing links keep working throughout — only *new* links,
projects and invites are paused. Dropping back under every limit clears the grace state; upgrading to
Pro clears it and logs `plan.upgraded`. Reminders are deduped by day bucket so re-runs never double-email.

## Non-goals (v1)

- Per-seat AI allowances.
- Retroactively disabling links or removing members on downgrade (warn, then block new ones).

## Milestones

### M1 — Free plan limits

- Add `src/lib/billing/planLimits.ts` with the launch constants and a `getWorkspacePlanLimits(orgId)` reader; make `src/app/pricing/page.tsx` import from it.
- Enforce the cap when sharing is enabled (doc create with share, `PATCH /api/docs/:id` shareEnabled, MCP `share_pdf` / `set_share_access`). *(Written as "active-link cap"; the cap has always counted shared **documents**, and links are not capped — see `FREE_DOCUMENTS`. The wording is left recognisable here as a record.)*
- Enforce the project cap on `POST /api/projects` and the MCP create path.
- Gate invites on Free: `POST /api/org-invites` and `/api/orgs/claim-join` reject when the workspace has no seat allowance; return `plan_limit`.
- Clamp the analytics window to 7 days on Free in `/api/docs/:id/shareviews`, the metrics page range picker and `lnkdrp_get_share_stats`.
- Grant starter credits once per user on the personal workspace; new team workspaces start at 0.
- Hide the dashboard "AI Credits" pill, the Usage/Limits credit views and the credits-exhausted banner behind a `NEXT_PUBLIC_FEATURE_CREDITS` flag.
- Upgrade prompts: dashboard Plan card and a sidebar nudge when at the document cap, linking to `/pricing`.
- Grace period cron: `/api/cron/plan-limits` (hourly) + `runPlanLimitsGraceSweep` in `src/lib/billing/planGrace.ts` — start/remind/block over-limit Free workspaces via `Org.planGrace`, owner emails (`sendPlanLimitEmail`), activity `plan.grace_*` / `plan.upgraded`; local runner `scripts/plan-limits-grace.ts`.

### M2 — Collaborator seats (post-launch)

Decision 2026-09-12: Pro includes 1 collaborator at launch; paid seats ship later.

- Stripe: add a recurring seat price (`STRIPE_SEAT_PRICE_ID`) with quantity; support a subscription that carries seats without the Pro plan.
- Webhooks: persist `licensedSeats` on the workspace subscription; recompute on `customer.subscription.updated`.
- Enforce seats at invite and join: members ≤ included + licensed; otherwise `plan_limit` with an "Add licence" hint.
- Teams tab: seats used / licensed, "Add licence" and "Remove licence" actions that update Stripe quantity (prorated); removing a member decrements.
- Grandfather existing over-limit workspaces and log them for follow-up.
- Copy: pricing page, Terms §8 and FEATURES.md updated only when billing is live.

## Verification

1. Free workspace with 3 enabled links: enabling a 4th returns `plan_limit` on web and MCP; disabling one allows it again.
2. Free workspace: invite returns `plan_limit`; Pro workspace with 1 collaborator: 2nd invite requires a licence; after "Add licence" the invite succeeds and Stripe shows quantity 1.
3. Metrics on Free never return data older than 7 days; Pro returns the full range.
4. New user: personal workspace shows starter credits; a new team workspace shows 0 and no credit UI unless the flag is on.

## Future

- Team tier with a larger included seat count and admin spend controls.
