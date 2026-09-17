# PRD — Workspace metrics

**Status:** Draft 2026-09-17, building (metis `prd__c4PtqUjxI`)
**Owner:** chrissanz
**Last updated:** 2026-09-17
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
4. **Headline numbers (four).** Views, Viewers, Reading time, Downloads, each with its change against the
   previous period. Selecting one switches the chart to that series. A fifth figure,
   "Documents opened: 12 of 31 shared", sits under the strip as a sentence, not a card.
5. **One hero chart.** The selected headline number by day over the range: smooth area with count labels.
6. **Ranked sections, in this order:**
   - **Top documents.** Views, viewers, average reading time, last opened; a row opens
     `/doc/:docId/metrics`.
   - **Top links.** Link label or audience, its document, views, last opened; a row opens that
     document's metrics filtered to the link.
   - **Most engaged people.** Named viewers ranked by reading time across all documents. Pro only;
     Free sees the count and the inline upsell notice (upsell pattern), never names
     ([[viewer identity gate]]).
   - **Gone quiet.** Shared documents with no opens in the range, newest share first, so the
     sender knows whom to nudge.
7. **Workspace output, secondary.** A compact line under the ranked sections: documents shared,
   links created and uploads in the range.
8. **Plan gating.** Free is limited to its analytics window (`FREE_ANALYTICS_DAYS`, 7 days): the 30- and
   90-day options show as locked and open the Upgrade modal. Identities are Pro-only as above.
   Everything else is on both plans.
9. **One endpoint.** `GET /api/metrics/workspace?range=7d|30d|90d` returns the whole page. It
   aggregates by `orgId` from `shareviews` and `sharevisits` (indexed; no global scan with a
   later join), caches for 60 seconds per workspace and range, and refetches on the realtime
   activity frame when a recipient opens something (debounced).
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
- Team-member activity or audit (who on the team did what).
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

## Verification

- `tsc`, `eslint` (0 errors), the analytics vitest suites including the reconciliation test.
- Seed corpus: for three documents, the Metrics page's numbers match their document metrics pages
  for 7, 30 and 90 days.
- Screenshots at 1440 and 390, light and dark, for Pro and Free workspaces, including the
  locked-range and hidden-names states.
- Empty workspace and shares-without-opens states rendered.

## Open questions

- Label: "Metrics" or "Insights"? This draft uses Metrics, matching the document pages.
- Should the dashboard Overview's view counters move to this endpoint (and its scan query be
  retired) as part of this work, or later?

## Future

- `lnkdrp_get_workspace_stats` MCP tool so an agent can answer "how is my outreach doing".
- Per-person page across documents, linked from Most engaged people.
- Weekly email digest built from the same endpoint.
- Compare two periods side by side; custom ranges.
