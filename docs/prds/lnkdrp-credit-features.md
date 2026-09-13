# PRD — Credit-worthy AI features (post-launch backlog)

**Status:** Backlog (not scheduled)
**Owner:** chrissanz
**Last updated:** 2026-09-12
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-mcp](./lnkdrp-mcp.md) · [SUBSCRIPTION](../SUBSCRIPTION.md) · [METRICS](../METRICS.md) · [REQUEST](../REQUEST.md)

> **Decision (2026-09-12, revised same day).** At launch only the automatic summary is included on every plan; AI compare is charged 2/5/12 by tier and the credit table is shown on `/pricing` (AI review is listed there as not released). Earlier text below that says "no AI feature costs credits" or "the table is empty" is superseded. Agent-supplied summaries over MCP are planned, not live.

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

1. **Credits stay per workspace** with the existing ledger, cycle grants and on-demand rate; the customer-facing table lists Summary (included) and AI compare (2/5/12); rows are added as features ship.
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
3. Summary remains zero-cost in the ledger after every milestone; AI compare stays at 2/5/12.

## Future

- Seat licences for collaborators (owner + 1 free, then $5/month per member), tracked separately from credits.
- Free-plan limits (3 active links, 1 project, 7 days of analytics) enforced in code.
