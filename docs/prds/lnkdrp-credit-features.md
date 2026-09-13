# PRD — Credit-worthy AI features (post-launch backlog)

**Status:** Backlog (not scheduled)
**Owner:** chrissanz
**Last updated:** 2026-09-13
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-mcp](./lnkdrp-mcp.md) · [SUBSCRIPTION](../SUBSCRIPTION.md) · [METRICS](../METRICS.md) · [REQUEST](../REQUEST.md)

> **Decision (2026-09-12, revised 2026-09-13).** Links, uploads, replacements and stats never need credits. Credits pay for AI runs. The automatic AI summary costs 1 credit per upload (basic; standard 2, advanced 5). It costs 0 when the uploader's own agent writes the summary (MCP `share_pdf` with summary and key points, or the API) and for files recipients upload through a request or replace link. AI compare on replacement costs 2/5/12 by tier and runs at Basic on Free, Standard on Pro by default. Gate split (PR 3, 2026-09-13): the owner's version history page, the change list, compare rerun and the automatic compare on replacement are credit-gated on every plan; only the recipient-facing version list (`shareAllowRevisionHistory`, `GET /api/share/:shareId/changes`) stays Pro. Personal Free workspaces get 50 credits to start, then a top-up to 10 on the 1st of each month (a floor, never additive), at most 15 credits a day, and no on-demand; team workspaces on Free get no allowance. Pro gets 300 credits per billing cycle plus optional on-demand at $0.10 under a spend limit. Out of credits: the upload completes and the link works, the summary is skipped and can be written later from the document page (1 credit), and compare and manual AI actions stop until credits return. Pricing change dated 2026-09-13: the automatic summary now costs 1 credit (previously included); starter credits already granted are kept in full, noted in Terms section 8 and on `/pricing`. The credit table is shown on `/pricing` (AI review listed as not released). Earlier text below that says "no AI feature costs credits", "summary is included" or "the table is empty" is superseded.

---

## Problem

The launch credit table priced summaries and reviews, which the user's own agent (Claude Code,
Cowork, Cursor) can already produce with more context and for free. Charging for them reads as a
tax and gives people a reason not to sign up. Credits should only meter work that LinkDrop is
uniquely positioned to do.

## Goal

Ship, one at a time, AI features that a client agent cannot replicate because it is not standing
where LinkDrop stands: holding every version, watching every viewer, or sitting on the recipient's
side of the link. Each feature becomes the first line of a real credit table.

## The test

A feature may cost credits only if **all** of these hold:

1. The sender's own agent cannot do it with the file it already has.
2. It uses data or a position only LinkDrop has (versions, viewer behaviour, the share page, inbound documents).
3. The value lands on the sender or the recipient, not on LinkDrop.

## Proposed decisions (to lock)

1. **Credits stay per workspace** with the existing ledger, cycle grants and on-demand rate; the customer-facing table lists Summary (1/2/5) and AI compare (2/5/12); rows are added as features ship.
2. **Pricing page** gains one row per shipped feature, with a fixed credit cost known before the run.
3. **MCP parity:** every feature here is exposed as an MCP tool with the same cost as the web.
4. **Free plan** gets 50 starter credits, then a top-up to 10 on the 1st of each month so the features are discoverable; Pro gets the 300-credit cycle grant plus on-demand.

## Approach

Each milestone is independent and can ship in any order. Ordered here by expected pull.

## Non-goals (v1)

- Bringing back doc "Quality review" of the sender's own document (the agent does this better).
- Per-seat AI allowances; credits remain per workspace.
- Training or fine-tuning on customer documents.

## Milestones

### M0 — Money correctness (shipped 2026-09-13, branch fix/production-readiness)

- Summary reserved before compare; upload never fails on a credit reservation; structured `ai` skip state on the upload plus a `credits.exhausted` feed row.
- Recipient uploads unbilled (`source: "recipient"`, 0 credits) with per-link and per-Free-workspace daily caps (20/day).
- Plan-aware compare tier default (Basic on Free, Standard on Pro), tier-free idempotency key, review runs at the charged tier.
- Fallback analysis refunds instead of charging; provider usage stored on the ledger row.
- One seeding path for starter credits (personal Free only); Free daily brake of 15 credits with its own 402 code and modal copy.
- Still open from the credits review: Free monthly floor (10), agent-supplied summary input on `share_pdf`/`POST /api/docs`, `whoami` costs derived from `creditsForRun`, and the gate split (owner history/compare credit-gated on every plan; recipient version list stays Pro).

### M1 — Recipient-side intelligence

- Define "engagement signals" from ShareView/ShareVisit: attention pages, return visits, time-on-deck, download intent.
- Add an `lnkdrp_who_is_warm` MCP tool and a dashboard panel that ranks viewers by engagement for one doc or a project.
- Generate a short natural-language follow-up brief per viewer ("spent 4 min on pricing, came back twice") priced as one credit per brief.
- Record cost in the schedule and surface it on the pricing page.

### M2 — Recipient Q&A on the share page

- Add an "Ask about this document" panel on `/s/:shareId`, scoped to the document text and page images already extracted.
- Meter per answered question against the sender’s workspace, with caps the sender sets per reader and per link (defaults on), so a single recipient cannot run up credits; the pricing page promises this.
- Log questions to the owner (untrusted content) so the sender sees what recipients asked.
- Expose per-share toggle and cap in `lnkdrp_set_share_access`.

### M3 — History compare as a premium tier

- Basic AI compare is charged (2 credits) today; this milestone decides whether to make it free.
- Offer an advanced compare that uses page images across versions and writes a change brief for recipients who enabled revision viewing.
- Price advanced compare separately if basic becomes free.

### M4 — Request review (when Requests return)

- Re-enable request repositories behind the existing flag.
- Meter the investor-focused review of inbound documents per submission, priced by tier.
- Expose `reviewEnabled` and cost in `lnkdrp_create_request_repo` and `lnkdrp_list_request_uploads`.

### M5 — Credits back on the site

- Restore the credit table on `/pricing` listing only shipped features.
- Update Terms §8 and the dashboard Usage tab to describe the metered features.
- Add the `costs` block back to `lnkdrp_whoami` with the live schedule.

## Verification

1. Each shipped feature has a fixed cost in `creditsForRun`, appears on `/pricing`, and is reachable from both the dashboard and MCP.
2. A Free workspace can try each feature within its allowance and hits a clear `out_of_credits` with a billing link afterwards.
3. Summary stays at 1/2/5 (0 when agent-written or recipient-uploaded) after every milestone; AI compare stays at 2/5/12.

## Future

- Seat licences for collaborators (owner + 1 free, then $5/month per member), tracked separately from credits.
- Free-plan limits (3 active links, 1 project, 7 days of analytics) enforced in code.
