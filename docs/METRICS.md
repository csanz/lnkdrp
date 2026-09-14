# Metrics (Docs + Share Viewer)

This document explains how LinkDrop metrics work end-to-end: **what we track**, **where it’s stored**, and **which endpoints/UI surfaces it**.

## Scope / key ideas

- **Share metrics** = recipient-facing `/s/:shareId` views (anonymous or signed-in). These power the owner page at `/doc/:docId/metrics`.
- **Internal doc timing** = workspace members viewing internal docs (versions), used for History recipients + per-viewer page timing.
- All metrics are **best-effort**:
  - Never block user interactions.
  - Avoid expensive reads on critical UI paths (denormalize viewer snapshots where needed).
  - Prefer “good enough” over perfect attribution (clock skew, tab close behavior, ad-blockers, etc.).

## Share metrics (recipient share viewer)

### Identity keys (public share viewer)

- **shareId**: public share id for a doc (`/s/:shareId`).
- **botId**: a client-generated per-browser/device id stored in localStorage (see `src/lib/botId.ts`).
- **botIdHash**: sha256 hash of `botId`; stored server-side (we do not persist raw botId).

### What we track (share viewer)

We track, per share viewer:

- **Unique view** (best-effort):
  - A “view” is recorded once per `(shareId, botIdHash)` (deduped server-side).
- **Distinct pages viewed** (unique pages):
  - Stored as `pagesSeen` per viewer/device (unique set).
- **Downloads**:
  - When downloads are enabled, we increment `downloads` and `downloadsByDay` on download intent.
- **Time spent** (best-effort, foreground-only):
  - `timeSpentMs`: total time increments (milliseconds).
  - `pageTimeMsByPage`: per-page total time increments (milliseconds).

### Where the data is stored (share viewer)

#### `ShareView` (aggregate, lifetime-ish per viewer/device)

- Model: `src/lib/models/ShareView.ts`
- Key: `(shareId, botIdHash)` (unique index)
- Contains:
  - `pagesSeen` (unique page numbers)
  - `timeSpentMs` (aggregate, all sessions)
  - `pageTimeMsByPage` (aggregate, all sessions)
  - viewer best-effort identity snapshots (userId/email/ip/name/emailSnapshot)

This is what the current metrics UI uses for “viewer totals”.

#### `ShareVisit` (per-visit/session per viewer/device)

To support **true per-visit** reporting (and “returned to page X” signals) we also store **visit-level** metrics:

- Model: `src/lib/models/ShareVisit.ts`
- Key: `(shareId, botIdHash, visitIdHash)` (unique index)
- A **visit** is defined as a best-effort **per-tab session**:
  - The client generates a random `visitId` and stores it in `sessionStorage`.
  - New tab = new `visitId` (new visit).
  - If a tab sits idle for a long time, we rotate the `visitId` (best-effort).

Each `ShareVisit` contains:

- `startedAt`, `lastEventAt`
- `timeSpentMs` (sum for this visit)
- `pagesSeen` (unique pages for this visit)
- `pageTimeMsByPage` (time per page for this visit)
- `pageVisitCountByPage` (how many page segments we recorded per page; used as “revisit count” signal)
- `pageEvents` (bounded list) of `{ pageNumber, enteredAt, leftAt, durationMs }` for **path analysis**

### Ingest endpoint (share viewer → server)

- Route: `POST /api/share/:shareId/stats`
- File: `src/app/api/share/[shareId]/stats/route.ts`

The share viewer (`src/components/PdfJsViewer.tsx`) posts best-effort events:

- `pageNumber` only (records “page seen”)
- `durationMs` (+ optionally `pageNumber`) (increments time totals)
- `visitId` (per-tab visit id, sessionStorage) attaches the event to a `ShareVisit`
- `enteredAtMs` + `leftAtMs` (best-effort timing bounds) enables recording page sequence events for a visit

Server behavior:

- Always updates `ShareView` aggregates (viewer/device totals).
- If `visitId` is present, also upserts/increments the appropriate `ShareVisit`.

## Owner metrics API (doc metrics page)

### Metrics page UI

- Page: `/doc/:docId/metrics`
- Client UI: `src/app/(app)/doc/[docId]/metrics/pageClient.tsx`

The UI shows:

- Views / downloads / pages viewed aggregates
- Viewer lists (authenticated + anonymous)
- Viewer details modal:
  - pages seen
  - best-effort time on page (aggregate)
  - **visits list** (per-tab visit sessions)
  - per-visit modal (time per page, revisits, and page sequence)

### Primary owner metrics endpoint (totals + viewers)

- Route: `GET /api/docs/:docId/shareviews`
- File: `src/app/api/docs/[docId]/shareviews/route.ts`
- Data source: `ShareView` (aggregated per viewer/device)

### Per-visit endpoints (new)

- **List visits for a viewer**:
  - `GET /api/docs/:docId/shareviews/visits?kind=authed&userId=...`
  - `GET /api/docs/:docId/shareviews/visits?kind=anon&botIdHash=...`
  - File: `src/app/api/docs/[docId]/shareviews/visits/route.ts`
  - Data source: `ShareVisit`

- **Visit details (sequence + revisits)**:
  - `GET /api/docs/:docId/shareviews/visits/:visitId`
  - File: `src/app/api/docs/[docId]/shareviews/visits/[visitId]/route.ts`
  - Data source: `ShareVisit`

Authorization model:
- Same as other doc APIs: the doc must be visible to the actor’s active org (legacy personal-org fallback supported).

## Internal doc page timing (workspace members)

This is separate from share links and is used for internal History/recipients tooling.

- Ingest endpoint: `POST /api/metrics/events` with `type=doc_page_timing`
  - File: `src/app/api/metrics/events/route.ts`
- Storage: `DocPageTiming`
  - File: `src/lib/models/DocPageTiming.ts`
  - Contains `sessionIdHash`, `pageNumber`, `enteredAt`, `leftAt`, `durationMs` for a specific `docId` + `version` + `viewerUserId`
- Query endpoint (aggregated): `GET /api/docs/:docId/history/:version/viewer/:userId`
  - File: `src/app/api/docs/[docId]/history/[version]/viewer/[userId]/route.ts`
  - Returns per-page aggregates (sum duration per page), plus first/last seen timestamps.

## Which collections are share analytics (and which are not)

Exactly three collections can answer a per-link question, because they are the only ones that carry
`shareId`:

- `ShareView` — lifetime per (link, viewer/device). Carries `shareId`, `shareLinkId`, `orgId`.
- `ShareVisit` — per-tab visit for the same keys. Carries `shareId`, `shareLinkId`, `orgId`.
- `ShareDownloadRequest` — download requests. Carries `shareId` and `docId`.

Everything else in the metrics surface is orthogonal to share links and must not be reconciled
against a link's numbers:

- `PageTiming` — route-level time for signed-in/temp actors. It has no `docId` and no `shareId`; the
  document identity only ever appears inside the free-text `path`, which is not a join key. Share
  routes do produce rows here (the session tracker runs everywhere), but anonymous visitors — most
  share recipients — are dropped at ingest, so these rows are neither complete nor attributable.
- `ProjectView` / `ProjectClick` — keyed on `projectId`. A share viewer never writes them.
- `DocPageTiming` — internal-member page timing per doc **version**. It now carries `shareId` /
  `shareLinkId` for the case where a member reads through a link, but a public share visitor can
  never write one (`/api/metrics/events` attributes only an existing actor whose workspace can see
  the document). External per-page time lives on `ShareView.pageTimeMsByPage` and
  `ShareVisit.pageTimeMsByPage`, both keyed by `shareId`.

## Per link vs. whole document (owner analytics)

`GET /api/docs/:docId/shareviews` answers both questions with **one pipeline and a different
`$match`** — `{ shareId }` for a link (`?shareId=<slug>`), `{ docId }` for the document. No
denormalized counter feeds the response (`Doc.numberOfViews` / `Doc.numberOfPagesViewed` are legacy
and only act as a floor), because a counter and a row count drift.

- `totals` covers the requested `days`, like `series` and `viewerCount`. `totalsAllTime` carries the
  lifetime figures for cards that want "ever".
- A window on `ShareView` means *viewers first seen in the window* (`createdDate`) — the same basis
  the views-by-day series has always used.
- `views`, `downloads` and **viewers** are additive: the document's figure equals the sum over its
  links. `pagesViewed` is the one **distinct set** ("how much of the deck was reached"), so the
  document's figure is the union across links — ≤ the sum of the per-link figures, and never more
  than the page count.
- **A viewer is counted once per link, not once per document.** One browser that opens the Sequoia
  link and the Accel link is two link-recipients, and the document reads 2. This is a deliberate
  choice in favour of *the aggregate equalling the sum of its parts*: the per-link table renders
  directly under the "All links" tiles and readers add the column up, so a document-level
  distinct-people count made the card say "3 people" over a table summing to 4 with nothing on the
  page to reconcile them. If a true distinct-people figure is ever needed it has to be a separate,
  separately-labelled number — not this one.
- **`views` means "link-recipients first seen in the window", not "opens".** A `ShareView` row is
  unique per (link, viewer) for life, so counting rows in a window and counting link-recipients in a
  window are the same arithmetic: `totals.views == totals.authenticatedViewers +
  totals.anonymousViewers`, always. Consequences to keep in mind: a recipient who reads the deck
  every day adds nothing after day one, and a day's `downloads` can exceed that day's `views`
  because downloads are bucketed from `downloadsByDay` rather than from row creation. Surfaces must
  therefore never print `views` and `viewers` side by side as two facts — the doc-page card and both
  per-link tables show **Viewers** only. Real per-open counting needs `ShareVisit` (one row per tab
  session); that collection is only populated from the visit-upsert fix onwards, so it cannot answer
  for historical traffic yet and has not been made the source.
- **"Last viewed" comes from `ShareView.lastViewedAt`, never `updatedDate`.** Mongoose stamps
  `updatedDate` on every update query, so any maintenance write — the analytics backfill, the
  viewer-name repair the metrics route itself fires in `after()`, a retention sweep — used to rewrite
  the whole Last-viewed column to the instant it ran, and an owner reloading their own metrics page
  made every link read "just now". `lastViewedAt` is written only by the view ingest paths
  (`POST /api/share/:shareId/stats`, `/s/:shareId/pdf`); every maintenance write passes
  `timestamps: false`; rows older than the field fall back to `updatedDate` and self-heal on the next
  real view.
- `?byLink=1` adds the same window grouped by link slug, in one aggregation. It is always the whole
  document's breakdown (the table compares links, so it ignores `?shareId=`), and unfiltered
  `sum(byLink[].views) == totals.views`. It includes slugs whose link was deleted — their rows stay
  in the document total — which is why the metrics table can render a "Deleted links" row that makes
  the column reconcile with the card above it.
- `downloadsEnabled` is a **label, not a filter**: it says whether downloads are allowed (this link,
  or any **live** link of the document — `isLinkActive`: enabled, not archived, not expired).
  Recorded downloads are counted either way, so turning a toggle off never erases history.
- `totalsAllTime`'s fallback to `Doc.numberOfViews` applies **only in document scope**. That counter
  is the sum over every link, so applying it under `?shareId=` reported the whole document's lifetime
  traffic as one link's.

## Best-effort caveats / interpretation notes

- **Time spent** counts **foreground time only** (we avoid counting hidden tab time).
- **Session/visit boundaries** are best-effort (per-tab sessionStorage).
- **Revisit counts** are derived from page segments recorded; they’re a signal, not ground truth.
- Clock skew can exist between client and server; we clamp/validate timestamps to reduce abuse.
- **Schema changes need a dev-server restart.** `mongoose.models.X` is cached per process, and Next's
  dev server keeps the model it compiled at boot; a path added to a schema after the server started
  is silently stripped by strict mode, so rows land with the new field missing while a fresh `tsx`
  process writes it correctly. If a newly added field is null on everything the running app writes
  and correct everywhere else, restart `next dev` before looking for a bug.

