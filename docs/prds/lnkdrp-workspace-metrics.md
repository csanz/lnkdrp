# PRD — Workspace metrics

**Status:** Draft 2026-09-17, building (metis `prd__c4PtqUjxI`)
**Owner:** chrissanz
**Last updated:** 2026-09-25
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-multi-links](./lnkdrp-multi-links.md) · [lnkdrp-plan-limits](./lnkdrp-plan-limits.md) · [METRICS](../METRICS.md)

---

## Problem

Every metric in LinkDrop lives on one document. `/doc/:docId/metrics` answers "how is this deck
doing", but nothing answers "how is my sharing doing": which documents are pulling attention this
week, whether readership is growing, which links went quiet, how much reading time the workspace
earned. To learn that today, a sender opens documents one at a time and adds numbers up in their
head.

The dashboard Overview tab has a few lifetime counters, but it is a settings page, not a place
people go to read results. Its view figures also come from a query that scans every share view in
the database and joins documents afterwards, which will not hold up as the product grows.

## Goal

A workspace-wide **Metrics** page in the main app. It opens on a small set of clear, high-level
numbers and one chart for the whole workspace, then ranks the documents, links and people behind
those numbers. Every row leads to the per-document metrics that already exist. A sender can see in
ten seconds whether things are going well and where to look next.

## Lessons carried in (binding)

- **High level first.** The 2026-09-17 metrics redesign was rolled back because it replaced a
  clean overview with page-level drill-down (archive: `archive/metrics-redesign-v1`). This page is
  the overview; drill-down stays on the existing document pages.
- **Charts are smooth area charts with count labels, never bars.** Recharts `Area type="monotone"`,
  emerald gradient, `valueLabels()` from `src/components/charts/ChartValueLabel.tsx`, first and last
  axis labels anchored inward.
- **The standard header.** `AppPageHeader` with `APP_PAGE_GUTTER`, like Search, Activity and
  Agents.

## Definitions (locked — they must match the document pages)

Taken from `src/app/api/docs/[docId]/shareviews/route.ts` and `src/lib/analytics/shareViewAggregates.ts`;
verified live on 2026-09-17 by a tracked visit (two sessions, per-page dwell recorded).

| Figure | Means | Source |
| --- | --- | --- |
| **Views** | Unique recipients active in the window (one person who came back three times is one view) | `shareviews`, recipient-only, activity inside the window |
| **Opens** | Tab sessions in the window — the returning-reader signal is Opens minus Views | `sharevisits`, one per session, bounded by `lastEventAt` |
| **Reading time** | Foreground time recorded while reading, best-effort | `sharevisits.timeSpentMs` summed over the window |
| **Downloads** | Download intents in the window | `shareviews.downloadsByDay` |
| **Pages viewed** | Distinct pages seen | `pagesSeen` / `pageTimeMsByPage` |

Two traps to respect: `shareviews` totals are **lifetime**, so anything range-scoped comes from
`sharevisits` or from day maps, never from the lifetime counters; and `opens` is missing rows for
traffic recorded before visits existed (`opensPartial`), so where the document page hides or
qualifies it, this page does the same.

## Proposed decisions (to lock)

1. **Name and place.** "Metrics" in the left sidebar, directly under Search, at `/metrics` inside
   the `(app)` layout. Icon: `ChartBarSquareIcon`. Header description: "How your shared documents
   are doing across this workspace."
2. **Same definitions as document metrics.** Recipients only (`RECIPIENT_ONLY_MATCH`, owner
   previews excluded), the same view, viewer, reading-time and download semantics as
   `/doc/:docId/metrics`. A document's row here matches its own metrics page for the same range.
   If they ever disagree, the document page is right and this page has a bug.
3. **Range.** A segmented control in the header's actions: 7 days, 30 days, 90 days, with 30 as the
   default and remembered per browser. Every number compares with the previous period of the
   same length (for example "+18% vs previous 30 days").
4. **Headline numbers (four).** **Views** (people), **Opens** (sessions), **Reading time**,
   **Downloads**, each with its change against the previous period, using the definitions above.
   Selecting one switches the chart to that series. Under the strip, one sentence carries the two
   facts a number can't: "12 of 31 shared documents were opened · 4 readers came back". Opens is
   suppressed (and the returns clause dropped) when the window's data is `opensPartial`, exactly as
   the document page does.
5. **One hero chart.** The selected headline number by day over the range: smooth area with count
   labels, UTC day keys, zero-filled so the line never skips a day.
6. **Ranked sections, in this order:**
   - **Top documents.** Views, opens, average reading time per view, last opened; a row opens
     `/doc/:docId/metrics`.
   - **Top links.** Link label or audience, its document, views, last opened; a row opens that
     document's metrics filtered to the link.
   - **Most engaged people.** Named viewers ranked by reading time across all documents. Pro only;
     Free sees the count and the inline upsell notice (upsell pattern), never names
     ([[viewer identity gate]]).
   - **Gone quiet.** Documents with at least one enabled, unexpired link and no recipient activity
     in the range, newest link first, so the sender knows whom to nudge. Archived documents are
     excluded from this list; they still count in the totals if they were read in the range.
   - **Who contributed.** The workspace's own side of the period: the members who added, replaced
     and shared documents, and the agents they connected, ranked by actions. An agent is kept apart
     from the person whose key it used, and carries that person on its second line ("by Christian"),
     because two members who each connect Claude Code otherwise produce two rows with the same name
     and nothing to tell them apart. Every row links to that contributor's page, which lists
     everything they changed. A contributor is identified by one key, `user:<userId>` or
     `agent:<client>@<ownerUserId|unknown>`, defined once in `src/lib/people/contributorKey.ts`, and
     the key decides the route: `/people/<userId>` for a member, `/agents/<client>/<ownerUserId>`
     for an agent, with `unknown` in the owner segment when the credential has no recorded creator.
     No surface builds those paths itself; the API sends each row's `href`. This section is on both
     plans: it names the workspace's own members and their agents, never recipients, so the
     [[viewer identity gate]] does not reach it.
7. **Workspace output, secondary.** A compact line under the ranked sections: documents shared,
   links created and uploads in the range.
8. **Plan gating.** Free is limited to its analytics window (`FREE_ANALYTICS_DAYS`, 7 days): the 30- and
   90-day options show as locked and open the Upgrade modal. Identities are Pro-only as above.
   Everything else is on both plans.
9. **One endpoint.** `GET /api/metrics/workspace?range=7d|30d|90d` returns the whole page. It
   aggregates by `orgId` from `shareviews` and `sharevisits` (indexed; no global scan with a later
   join, and no lifetime counters for range figures), caches for 60 seconds keyed by workspace,
   range **and plan**, and refetches on the realtime activity frame when a recipient opens
   something (debounced). A Free request for 30d or 90d returns the clamped 7-day window with
   `clampedByPlan: true`, never older data.
10. **Empty and early states.** A new workspace sees what the page will show and one action
    ("Share a document"). A workspace with shares but no opens yet sees zeros with "No opens
    yet in the last 30 days", not a blank page.

## Approach

- **Service layer.** `src/lib/analytics/workspace/` holds pure aggregation helpers (period
  bucketing, previous-period deltas, ranking, quiet-doc selection) with unit tests, and one
  Mongo-facing function that runs the aggregations in parallel. The route stays thin.
- **Reconciliation test.** For a handful of seeded documents, the workspace endpoint's per-document
  numbers equal what the document metrics endpoints return for the same range.
- **Indexes.** Confirm `shareviews { orgId, lastViewedAt }` / `sharevisits` equivalents cover
  the queries; add a migration if not (same pattern as 20260916_0002).
- **UI.** `src/app/(app)/metrics/` page and client, components under
  `src/components/workspaceMetrics/`, reusing the chart helpers and design tokens. It works at 390px,
  in light and dark themes, with a loading skeleton that keeps the layout from shifting.
- **Verification data.** The existing seed corpus (tag `sc20260917048x`: 50 docs, ~552 people).

## Non-goals (v1)

- A per-person page that follows one viewer across documents. That is planned separately, entered
  from the viewer modal.
- Page-level reading analytics on this page (it stays on documents).
- Custom date ranges, CSV export, scheduled email digests.
- Team-member activity or audit (who on the team did what). Partly superseded after v1: the "Who
  contributed" section and the contributor pages it links to answer this from the activity log for
  the selected range. A full audit trail, with sign-ins and permission changes, is still out.
- Rollups across several workspaces.
- An MCP tool for workspace metrics (see Future).

## Milestones

### M1 — Workspace metrics API
- Aggregation helpers in src/lib/analytics/workspace with unit tests (ranges, deltas, ranking, quiet docs)
- GET /api/metrics/workspace: range parsing, plan window clamp, recipient-only aggregation by orgId, 60s cache
- Index check and migration if the orgId queries are not covered
- Reconciliation test against per-document metrics for the same range

### M2 — Page shell, headline numbers and chart
- Sidebar "Metrics" item under Search and the /metrics route in the app layout
- AppPageHeader with the range control (Free locks 30/90 behind the Upgrade modal)
- Headline strip (views, viewers, reading time, downloads) with period-over-period change; selecting one drives the chart
- Hero smooth area chart with count labels; loading skeleton, empty and error states

### M3 — Ranked sections
- Top documents with drill-through to document metrics
- Top links with drill-through filtered to the link
- Most engaged people (Pro) with the Free inline upsell notice
- Gone quiet list and the workspace output line

### M4 — Polish and verification
- Realtime refresh on recipient activity (debounced)
- 390px layout, light and dark themes, keyboard focus and accessible names
- Verified on the seed corpus with screenshots; API p95 under 500 ms on that corpus
- docs/METRICS.md section for workspace metrics

## Risks

- **Heavy workspaces.** Ranked lists and series must stay bounded (top 8) and indexed; the query
  budget is one round of parallel aggregations, p95 under 500 ms on the seed corpus.
- **Best-effort timing.** Reading time is foreground-only and depends on the reader's tab; treat it
  as a comparison signal between documents, never as a billing-grade figure. Copy should say
  "time reading", not "time on file".
- **Partial opens on old traffic.** See the definitions table; showing a low Opens next to a higher
  Views would read as a bug.
- **Duplicate figures.** The dashboard Overview shows lifetime counters computed by a different
  query. Until they share this endpoint, the two can disagree; the open question below decides when.

## Success criteria

- A sender can answer "is this week better than last, and which document is carrying it" without
  opening a document.
- Every figure on the page equals the same figure on the document pages for the same window.
- The page is the entry point people open on purpose: it is one click from the sidebar and needs no
  filters set before it says something useful.

## Verification

- `tsc`, `eslint` (0 errors), the analytics vitest suites including the reconciliation test.
- Seed corpus: for three documents, the Metrics page's numbers match their document metrics pages
  for 7, 30 and 90 days.
- Screenshots at 1440 and 390, light and dark, for Pro and Free workspaces, including the
  locked-range and hidden-names states.
- Empty workspace and shares-without-opens states rendered.

## Open questions

- **Locked 2026-09-17:** the label is "Metrics", matching the document pages.
- Should the dashboard Overview's view counters move to this endpoint (and its scan query be
  retired) as part of this work, or later? Proposal: later, as a follow-up once this page's numbers
  have been trusted for a week; the risk of changing the dashboard's meaning mid-build is not worth
  the saved query.

## Future

- `lnkdrp_get_workspace_stats` MCP tool so an agent can answer "how is my outreach doing".
- Per-person page across documents, linked from Most engaged people.
- Weekly email digest built from the same endpoint.
- Compare two periods side by side; custom ranges.
