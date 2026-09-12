# PRD — Credit-worthy AI features (post-launch backlog)

**Status:** Backlog (not scheduled)
**Owner:** chrissanz
**Last updated:** 2026-09-12
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-mcp](./lnkdrp-mcp.md) · [SUBSCRIPTION](../SUBSCRIPTION.md) · [METRICS](../METRICS.md) · [REQUEST](../REQUEST.md)

> **Decision (2026-09-12).** At launch, no AI feature costs credits. The automatic summary and the
> history compare are included on every plan, and an agent sharing over MCP can supply its own
> summary so ours is skipped. The credit ledger keeps running underneath as a fair-use meter but is
> not shown on the pricing page. Credits come back only for features that pass the test below.

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

1. **Credits stay per workspace** with the existing ledger, cycle grants and on-demand rate; the customer-facing table is empty until the first feature below ships.
2. **Pricing page** gains one row per shipped feature, with a fixed credit cost known before the run.
3. **MCP parity:** every feature here is exposed as an MCP tool with the same cost as the web.
4. **Free plan** gets a small monthly allowance so the features are discoverable; Pro gets the cycle grant plus on-demand.

## Approach

Each milestone is independent and can ship in any order. Ordered here by expected pull.

## Non-goals (v1)

- Bringing back doc "Quality review" of the sender's own document (the agent does this better).
- Per-seat AI allowances; credits remain per workspace.
- Training or fine-tuning on customer documents.

## Milestones

### M1 — Recipient-side intelligence

- Define "engagement signals" from ShareView/ShareVisit: attention pages, return visits, time-on-deck, download intent.
- Add an `lnkdrp_who_is_warm` MCP tool and a dashboard panel that ranks viewers by engagement for one doc or a project.
- Generate a short natural-language follow-up brief per viewer ("spent 4 min on pricing, came back twice") priced as one credit per brief.
- Record cost in the schedule and surface it on the pricing page.

### M2 — Recipient Q&A on the share page

- Add an "Ask about this document" panel on `/s/:shareId`, scoped to the document text and page images already extracted.
- Meter per answered question against the sender's workspace, with a per-share cap the sender sets.
- Log questions to the owner (untrusted content) so the sender sees what recipients asked.
- Expose per-share toggle and cap in `lnkdrp_set_share_access`.

### M3 — History compare as a premium tier

- Keep the basic text diff included on every plan.
- Offer an advanced compare that uses page images across versions and writes a change brief for recipients who enabled revision viewing.
- Price advanced compare only; basic stays free.

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
3. Summary and basic history compare remain zero-cost in the ledger after every milestone.

## Future

- Seat licences for collaborators (owner + 1 free, then $5/month per member), tracked separately from credits.
- Free-plan limits (3 active links, 1 project, 7 days of analytics) enforced in code.
