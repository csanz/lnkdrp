# PRD — Enterprise tier (custom domains, unlimited seats, admin workspaces)

**Status:** Draft (v1)
**Owner:** chrissanz
**Last updated:** 2026-09-12
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-plan-limits](./lnkdrp-plan-limits.md) · [lnkdrp-mcp](./lnkdrp-mcp.md) · [Deploy_1](../deploy/Deploy_1.md)

> **Decision 2026-09-12.** The pricing page gets an Enterprise "Talk to us" block with no price. Nothing on it is self-serve at launch; every item is delivered by hand for the first customers and productised here as demand proves out.

## Problem

Legal, fundraising and sales teams that send documents daily ask for three things Pro cannot answer: their own domain on share links, more than a couple of seats on one invoice, and someone accountable (DPA, data location, retention). Without a tier that names those, they bounce or ask for a discount on Pro.

## Goal

Qualify and close enterprise leads through a conversation, then deliver the promised items with the smallest product changes that make them real: a custom share-link hostname per workspace, an `enterprise` plan with unlimited collaborators, and multiple workspaces under one billing owner.

## Proposed decisions (to lock)

1. Enterprise is sold, not bought: no price on the card, "Talk to us" goes to hi@lnkdrp.com.
2. Plan id `enterprise` in `src/lib/billing/planLimits.ts`: unlimited links, projects, analytics and collaborators; set manually on the workspace subscription (`Subscription.plan = "enterprise"`, Stripe optional) until self-serve exists.
3. Custom domain = one hostname per workspace (CNAME to the app) resolved on `/s/:shareId`, `/p/:shareId`, `/r/:token` and the PDF/OG routes; the primary domain keeps working for every link.
4. Enterprise workspaces are ordinary team workspaces that share a billing owner; an "org group" is a later abstraction, not v1.
5. Nothing on the card that is not buildable in a week: no SSO, no SLA numbers, no audit exports until they exist.

## Approach

### Card copy (pricing page)
Own domain on share links · As many seats as you need, on one invoice · Private workspaces per team with an admin who sees all of them · Higher file-size and retention limits · Priority support and a DPA · Button "Talk to us" · Helper "Pricing based on seats and volume. We reply within a business day."

### Custom domains
- `Org.customDomain: { hostname, verifiedAt, txtToken }` + unique index on hostname.
- Verification: DNS TXT `_lnkdrp.<hostname>` = token, checked by an admin action (no cron in v1).
- Hosting: Vercel domain added per customer by hand in v1 (`vercel domains add`), automated later via the Vercel API.
- Routing: `src/lib/urls.ts` builds public URLs from the workspace's verified hostname when present; share/request/PDF/OG routes accept requests on any verified hostname (middleware-free: read `host` in the route and look up the org).
- Auth cookies stay on the primary domain; recipient-side pages need no session.

### Plan and seats
- `limitsForPlan("enterprise")` → all `null` (unlimited); `checkLimit` short-circuits.
- Admin UI: `/a/data/workspaces/:id` gains "Set plan: free | pro | enterprise" and "Custom domain".
- Billing: manual invoicing in v1; Stripe subscription with a bespoke price when the first customer needs card billing.

### Multi-workspace admin
- `Org.billingOwnerUserId` (nullable) marks workspaces under one enterprise owner; dashboard Teams tab lists them for that user. Deeper org-group features deferred.

## Non-goals (v1)
- SSO / SAML, audit log exports, SLA credits, per-workspace data residency.
- Self-serve enterprise checkout.

## Milestones

### M1 — Tier and card
- Add the Enterprise "Talk to us" block to `src/app/pricing/page.tsx` (no price, mailto hi@lnkdrp.com).
- Add plan id `enterprise` to `src/lib/billing/planLimits.ts` and `Subscription.plan`; `limitsForPlan` returns unlimited; tests in `tests/credits/planLimits.test.ts`.
- Admin action to set a workspace plan in `src/app/api/admin/data/workspaces/[workspaceId]/route.ts` and the admin page.
- Proves: an enterprise workspace has no caps and the card is live

### M2 — Custom share-link domains
- `Org.customDomain` fields, unique hostname index, migration in `db/migration/`.
- Admin "Custom domain" form with TXT verification (`src/lib/domains/verify.ts`, DNS lookup).
- `src/lib/urls.ts` builds share/request URLs from the verified hostname; routes under `src/app/s`, `src/app/p`, `src/app/r`, `src/app/s/[shareId]/pdf` and the OG image resolve the workspace from `host`.
- Vercel domain provisioning runbook in `docs/deploy/` (manual in v1).
- Proves: a link on docs.customer.com opens the viewer with summary and records views to the right workspace

### M3 — Enterprise admin
- `Org.billingOwnerUserId`; Teams tab lists all workspaces for that owner with member counts.
- Manual invoicing notes in `docs/SUBSCRIPTION.md`; Stripe bespoke price when required.
- Proves: one owner administers several workspaces from one dashboard

## Verification
1. `checkLimit` returns ok for every limit on an `enterprise` workspace with 50 members and 500 links.
2. A verified custom hostname serves `/s/:shareId` and `/s/:shareId/pdf`; an unverified hostname 404s.
3. Share stats and activity events from a custom-domain view land on the owning workspace.
4. The pricing card renders with no price and the mailto link.

## Future
- Self-serve domain provisioning via the Vercel API; SSO; audit exports; data residency.
