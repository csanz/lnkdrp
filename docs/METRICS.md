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

The share viewer (`src/components/PdfJsViewer.tsx`) posts best-effort events. What it sends is
decided by `src/lib/share/readingClock.ts`, a pure state machine with its own tests; the viewer
only feeds it browser events and posts what it flushes.

- `pageNumber` only (records “page seen”)
- `durationMs` — the **visit clock**, how long the tab was open on this document. Feeds
  `timeSpentMs`.
- `pageDurationMs` (+ `pageNumber`) — the **page clock**, time on that one page. Feeds
  `pageTimeMsByPage`.
- `visitId` (per-tab visit id, sessionStorage) attaches the event to a `ShareVisit`
- `enteredAtMs` + `leftAtMs` — timing bounds, and **the exit signal**: their presence is what says
  the reader has *left* that page, which is what promotes the post to a `pageEvents` segment, a
  `pageVisitCountByPage` revisit tick, and a `toPage` the live metrics pages read.

Two rules that are easy to break and were each broken once:

- **The two clocks are separate counters over the same seconds.** Time on page 4 is also time in
  the visit, so one number can never feed both — `visitTimeIncrement` reads only `durationMs` and
  `pageTimeIncrement` only `pageDurationMs` (`src/lib/analytics/shareTiming.ts`). Their sum is a
  ceiling, not a total: reported page time must never exceed reported visit time, which is the
  property `scripts/verify-share-analytics.ts` and the clock's fuzz test both assert.
- **A heartbeat sends page time with no bounds.** The 30-second heartbeat reports the page the
  reader is *still on*, because a document with one page never turns a page and so recorded
  nothing until the tab closed. It carries `pageDurationMs` and omits `enteredAtMs`/`leftAtMs`, so
  the server moves the clock and writes no phantom exit. The clock keeps a `pageReportedMs` ledger
  so the eventual exit flush sends only what is left.

Server behavior:

- Always updates `ShareView` aggregates (viewer/device totals).
- If `visitId` is present, also upserts/increments the appropriate `ShareVisit`.

## Owner metrics API (doc metrics page)

### Metrics page UI

- Page: `/doc/:docId/metrics`
- Client UI: `src/components/metrics/MetricsView.tsx` (the page files under
  `src/app/(app)/doc/[docId]/metrics/` are a shell that picks the scope)

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
- `ProjectLinkView` — landings on a **project** link's page (`/p/:shareId`). Carries `shareId`,
  `shareLinkId`, `projectId`, `orgId`, and the same `botIdHash` identity `ShareView` uses, so a
  landing and the reading that follows it are one person. It holds visits and `docsOpened`, never
  reading time — that stays on `ShareView`/`ShareVisit` under the same project-link `shareId`. It
  is the public counterpart of `ProjectView`, which a recipient cannot write.
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

## Project links: how a data-room visit is keyed

A project link (`kind: "project"` on `ShareLink`, `/p/:shareId`) has **one slug and N documents**,
which is the one place share analytics stop being "one link, one document". Reading it before
writing any project metrics query saves getting the same three figures wrong.

A recipient behind a project link produces:

| row | one per | what it answers |
|---|---|---|
| `ProjectLinkView` | (link, viewer) | who arrived, how many visits, which documents they opened |
| `ShareView` | (link, viewer, **document**) | pages seen and lifetime reading time in that document |
| `ShareVisit` | (link, viewer, tab session, **document**) | that session's page sequence and per-page dwell |

**The `docId` lives inside `botIdHash`.** `ShareView` is unique on `{shareId, botIdHash}` and
`ShareVisit` on `{shareId, botIdHash, visitIdHash}`. One project link with three documents needs the
document in that key or all three collapse into one row and their page numbers merge — page 3 of the
term sheet adding time to page 3 of the deck. Rather than change two unique indexes under live
traffic, the ingest writes the composite

    botIdHash = "<sha256(botId)>" + "." + "<docId>"       // project links only

(`projectViewerKey` in `src/lib/share/projectPublic.ts`). It is a composite, not a hash of one, so
the viewer is recoverable: `splitProjectViewerKey`, a `^<botIdHash>\.` prefix match, or
`{ $substrCP: ["$botIdHash", 0, 64] }` in an aggregation. Document links are untouched and keep a
bare 64-character digest, which is also how a reader tells the two apart without consulting the link.

Three consequences, which M4's queries must honour:

- **Views for a project link are not `countDocuments({ shareId })`.** That counts (viewer ×
  document opened). "People who came through this link" is `ProjectLinkView` rows for that `shareId`;
  "documents opened" is the same rows' `docsOpened`. `ShareLink.viewCount` on a project link is
  **recipients**, the same quantity the field means on a document link: `projectLinkStatsByShareId`
  groups on `PROJECT_LINK_VIEWER_KEY_EXPR` before counting, the ingest bumps the stored counter only
  when the `ProjectLinkView` upsert inserts, and `reconcileShareLinkCounters` recomputes project
  links through that same function instead of its row-count pipeline. (It did read as the row count
  once: `/links` said 4 for a link whose metrics page, workspace card and MCP stats all said 3.)
- **`ShareVisit` counts (tab session × document), not tab sessions.** The `visitId` is stored per
  `shareId` in `sessionStorage`, and a project link is one `shareId` for the whole data room, so one
  tab reading two documents writes two rows sharing a `visitIdHash`: *one session in the data room,
  one row per document in it*. Session counts must be `distinct visitIdHash`.
- **A read through a project link is the PROJECT's view, not the document's.** This is the locked
  rule, and it holds on *every* document-scoped surface — see "Project-link rows are not
  document-link rows" below for the list. Scoped by `docId`, a viewer still has exactly one row per
  link, so the arithmetic a document page does is unchanged; what changed is which rows are in
  scope. (This bullet used to read "per-document figures are unaffected", and that was true only of
  the live metrics route: the snapshot rollup and the ingest counters kept counting the data room's
  reading as the document's, and the same document reported three different numbers on three
  surfaces.)

Everything else behaves as it does for a document link, deliberately: `isOwnerPreview` is recorded
and never counted, `lastViewedAt` is written only by an ingest, and per-page time comes from the same
`shareTiming` helpers. Verified live on 2026-09-17 — one recipient reading two documents behind one
project link produced two `ShareView` rows, two `ShareVisit` rows with a shared visit id, one
`ProjectLinkView` with both documents, and **nothing at all under either document's own link**.

### …and where the document page says so

Excluding the data room's reading from the document's figures is right, and on its own it made the
document metrics page *lie by omission*: an owner could watch "Michael J read USAVX Deck" arrive in
the activity feed and then find nobody on that document's metrics page, because he had read it
through the project link `4XX8hbn291OC` and not through the document's own.

So the rows are reported, in their own place, never folded into a total:

- `GET /api/docs/:docId/shareviews` answers `projectLinkTraffic` (absent when there is none):
  `{ views, viewers, links[], viewerRows[] }`, built from the same `docOnlyShareIdMatch`
  slugs the totals *exclude*, and matched with `RECIPIENT_ONLY_MATCH` and the window like every
  other figure on the route.
- Identity follows the page's gate exactly: on `analyticsTier === "basic"` the aggregation never
  projects a name, so a Free workspace gets the counts and the "via *project*" grouping and no
  identities at all.
- The page renders a **THROUGH PROJECT LINKS** card with a `projectLinkMetricsHref` link per
  project link, so the activity feed, the workspace's Top Links and this card all land on the same
  screen — plus one line under the Views tile ("+N views came through project links, counted with
  the project") so the big number is never read as the whole story.

`totals`, `byLink` and `Doc.numberOfViews` are untouched: the three surfaces still agree, which is
the whole point of the rule above.

### A recipient who changes the name they gave

"Introduce yourself" is answered once per browser and remembered there, so the interesting case is
the *second* answer — a typo fixed, a surname added. The row for the link they were on takes the new
value from the ingest's own `$set`; `propagateViewerIdentity`
(`src/lib/share/viewerIdentity.ts`) writes it through to the rest of that person's rows, under four
rules: one workspace (the document owner's), this viewer only (the bare digest **or** any
`<digest>.<docId>` project key), never over an identity that came from an account, and only where
the stored value differs.

That last rule is load-bearing. The realtime server watches `shareviews` for updates touching
`viewerName` / `viewerEmailSnapshot` and broadcasts a `viewer` frame to the owner's room; the metrics
pages subscribe and refetch (debounced — one rename is a burst of rows), so a corrected name fixes
itself on an open page. A no-op write would put a frame on the wire for nothing.

## Owner metrics API (project metrics page)

The same page, the same component, a different scope.

- Page: `/project/:projectId/metrics` (`?shareId=` scopes it to one link, like the document one)
- Client UI: `src/components/metrics/MetricsView.tsx` — **shared with the document page**. The scope
  (`projectMetricsScope`) decides the API base, the breadcrumb noun, and two capabilities a project
  does not have: per-page time / per-visit timelines, and the version-history link setting.
- Route: `GET /api/projects/:projectId/shareviews`
- File: `src/app/api/projects/[projectSlug]/shareviews/route.ts`

It returns the **same envelope** as the document endpoint (`days`, `analyticsDaysLimit`,
`analyticsTier`, `viewerCount`, `totals`, `totalsAllTime`, `series`, `byLink`, `linksTotal`,
`deletedLinkResidual`, `link`, `downloadsEnabled`, `viewers`, `anonymousViewers`) — that is the
condition for one component rendering both. What differs all follows from a project link spanning
many documents:

- **`totals.pagesViewed` is replaced by `totals.docsOpened`** — distinct documents recipients opened
  through the project's links. "How much of the deck was reached" has no project-scale meaning; "how
  many of the documents did they open" does. Viewer rows carry `docsOpened` in place of `pagesViewed`.
- **No per-page maps and no visit timeline.** `pageTimeMsByPage` / `pagesSeen` are per-document
  facts, and a "session" here spans documents, so its page sequence has no project meaning. The
  project scope therefore has no `/shareviews/visits` sibling and the drawer shows **`viewers[].docs`**
  instead: which documents that person opened and how long each held them, longest first, with
  `viewers[].sessions` (distinct `visitIdHash`, deduplicated across the documents in one tab) for the
  Sessions tile. The rows stay clickable; only the card inside the drawer changes.
  - **The "Recent sessions" card is deliberately absent on a project**, not missing. The document
    drawer lists each session as *timestamp · duration · page sequence*, and the page sequence is
    the reason the list is worth a row — on a project it does not exist (page 3 of the term sheet
    and page 3 of the deck are not the same axis), and there is nothing behind a row to open.
    `viewers[].sessions` is a **count**, not a list: the timestamps would need their own aggregate
    over `ShareVisit`, grouped by `visitIdHash` and rolled up across the documents in each tab.
    Worth adding the day a project session has somewhere to lead; today "Documents opened" carries
    the part of the story that has a project meaning.
- **Two figures exist only here** (`src/lib/analytics/project/pipelines.ts`, milestone M4):
  - **`totals.landings` / `totals.landedWithoutOpening`** — a project link has a *landing page*, so
    arriving and opening are different events. Someone can open `/p/:shareId`, read the file list and
    leave; `ShareView` never hears about them and `ProjectLinkView` is the only record they exist. On
    a data room they are frequently the majority, which is why the VIEWS tile names them.
    `landings` sums `ProjectLinkView.landingsByDay` over the window's UTC day keys — *not* the row's
    `visits` counter, which is cumulative: because the window selects rows by last activity, summing
    it reported a recipient's whole history inside whatever window was asked for (forty landings
    over six months all landing in a `days=3` answer). Rows written before the per-day map existed
    contribute 1, since they are in the window and did land in it. `landedWithoutOpening` counts
    rows whose landing falls in the window and whose `docsOpened` is still **empty** — lifetime, not
    windowed, so it means "has never opened anything through this link", which is what the UI claims.
    `ProjectLinkView.visitIdHashes` (the tab sessions already counted) is capped at the most recent
    `VISIT_ID_HASH_CAP`: the public landing route is rate-limited per IP but not per device, and an
    uncapped `$addToSet` could walk one row into the 16MB BSON ceiling, past which that link stops
    counting landings entirely.
  - **`byDoc` / `docsTotal`** (`?byDoc=1&topDocs=n`) — the project's documents ranked by recipients,
    the analogue of a document's per-page story. Unlike `byLink` it **follows `?shareId=`**: "which
    files did *this* recipient group open" is precisely the per-link question, where ranking the link
    the page is about against its siblings is not. `byDoc[].viewers` counts (document, link, viewer)
    buckets, so it can exceed `totals.views` — one person who opened two files appears under both,
    and the card ranks documents rather than partitioning recipients. The UI says so rather than
    leaving the reader to discover it: the DOCUMENTS rows read "opened by N", never "N viewers"
    (the LINKS card's unit), and the card carries the same kind of one-line footnote the
    deleted-link residual has.
  - **`docsTotal` counts what a recipient could actually open**: `shareEnabled: { $ne: false }`, the
    same filter `projectDocFilter` applies to `/p/:shareId`. A project with ten documents, seven of
    them unshared, must not report that nobody opened seven files that were never on offer. The
    "N of them opened" sentence clamps to it, because `docsOpened` counts documents in the analytics
    rows and those include documents since removed from the project.
- **Downloads have one source, not two.** The project's download figures come from
  `ShareView.downloadsByDay` over the project's `shareId`s — identical arithmetic to the document
  page. `ProjectLinkView.downloadsByDay` records the same intent at landing level and is **not**
  added to it; adding the two would double every download.

**The views-by-day series buckets a (link, viewer) once**, by its *last* activity — the same rule
`ACTIVITY_DAY_KEY_EXPR` gives a document, where a row already carries one activity date. It has to be
done in two stages here (group to the viewer with `$max` of the activity date, *then* to the day),
because one (link, viewer) owns one row per document opened: grouping on `{day, viewer}` put a
recipient who read the deck on Monday and the term sheet on Wednesday into two buckets, and the area
under the chart then exceeded the VIEWS tile it is supposed to equal.

**Project-link rows are not document-link rows.** A `ShareView`/`ShareVisit` written through a
project link carries the opened document's `docId`, so `/api/docs/:docId/shareviews` (and its
`/visits` sibling) bound their `{ docId }` match with a `$nin` of the project slugs that document has
traffic on — otherwise a data room's reading entered the document's own totals and, since the label
join is `{docId, shareId}` and a project link's `docId` is null, came back labelled "Deleted link"
for a link the owner can see live on `/project/:id/links`. The set is derived from the rows
themselves, not from current project membership, so a document removed from a project stays clean.

That exclusion is **one rule on every document-scoped surface**, and the rule is the heading above:
a read through a project link is the project's view, and the document's own figures never count it.
`src/lib/analytics/docScope.ts` owns it (`projectLinkSlugsForDocs` / `docOnlyShareIdMatch`) and the
surfaces are:

| surface | how it obeys |
|---|---|
| `GET /api/docs/:docId/shareviews` (+ `/visits`) | `docOnlyShareIdMatch` on every aggregate |
| `rollupDocMetrics` → `Doc.metricsSnapshot` (dashboard card, QuickStats) | the same `$nin` on views, windowed downloads and lifetime downloads, computed once per batch |
| `Doc.numberOfViews` ingest (`POST /api/share/:shareId/stats`) | not incremented when the slug is a project link (`projectTarget`) |
| `Doc.numberOfViews` ingest (`GET /p/:shareId/:docId/pdf`) | never incremented; every row on that route is a project link's |
| `Doc.numberOfPagesViewed` ingest (`POST /api/share/:shareId/stats`) | same `projectTarget` guard as `numberOfViews`, so the dashboard's two sharing tiles cannot disagree about one reading |
| `totalsAllTime`'s legacy floor | skipped for a document that has project-link traffic, since the counter predates the rule and is contaminated |
| `GET /api/docs/:docId/pages` (the reading page + its people/visits siblings) | `docOnlyShareIdMatch` in `loadReadingCore`, on the rows, the visits and the all-time pass |
| Workspace **Top documents** (`src/lib/analytics/workspace/query.ts`, `byDoc`) | the `own*` half of the facet — see the workspace section below |

The traffic is not lost: it is reported on `/project/:id/metrics`, which is the scope that owns it.
Before this, `Doc.metricsSnapshot.lastDaysViews` and `Doc.numberOfViews` exceeded what
`/doc/:id/metrics` showed for the same document and window — QuickStats flashed the larger figure
and swapped to the smaller one, and the dashboard card disagreed permanently. Pinned by
tests/lib/docMetricsScope.test.ts.

The `ShareView` rows themselves are untouched, so a workspace-level aggregate *built from the rows*
still counts the reading exactly once: `/api/metrics/workspace`'s headline, its day series and its
`docsOpened` sentence all include data-room reads, and only its per-document rows subtract them (see
"Workspace metrics" below). The exception is `/api/dashboard/stats`, whose four `sharing` figures are
sums of the legacy per-document counters and are therefore document-scoped like the counters
themselves — its tiles exclude data-room reads while the chart above them, which is row-derived,
includes them. That is stated on the route and is the price of not re-deriving an all-time figure
from a full scan; the workspace metrics page is where the workspace-scoped question is answered.

The counters obey the rule **from the ingest guard forwards only**. Data-room reads taken before it
are still inside `Doc.numberOfViews` / `Doc.numberOfPagesViewed`, and nothing later subtracts them:
one workspace's dashboard read 14 views against 7 on both of its documents' own pages. The one-time
repair is `scripts/doc-view-counters-recount.ts` (recomputes both counters from `ShareView`,
recipients only, project slugs excluded — the same query the metrics route answers from). An
environment where it has not run has contaminated tiles, not agreeing ones.
The **workspace** Top Links card (`src/lib/analytics/workspace/query.ts`) obeys the heading too, in
the one way a workspace-scoped list can: it ranks **one row per `shareId`**, and a row carries a
`kind`. A project link is labelled with its own label over the *project's* name (a folder glyph
beside it), and opens `/project/:projectId/metrics?shareId=` — never `/doc/:docId/metrics?shareId=`,
which 404s for a link the document does not own. Its `views` are its recipients, per the dedup rule
below, so the row equals the project page it opens; `linkReaderKeyExpr` in
`src/lib/analytics/workspace/match.ts` strips the composite for that count. Document links are
untouched. Before this the card grouped on `{ shareId, docId }`: one project link printed once per
document opened through it, each row holding a slice of its traffic under a document's title, and
the duplicate rows collided on their React key.

**Every count is deduplicated by the composite key**, per the section above: the anonymous identity
is the first 64 characters of `botIdHash`, `views` is the count of distinct (link, viewer) buckets
rather than of rows, and `opens` is the count of distinct `visitIdHash` rather than of `ShareVisit`
rows. `src/lib/analytics/project/viewerKey.ts` holds those expressions; the document route's
`LINK_VIEWER_KEY_EXPR` stays as it is and must not learn about the composite. Before the dedup, a
data room with two documents reported a single recipient who opened both as two viewers and two
opens.

### Drilling into one reader's reading of one document

`GET /api/projects/:projectSlug/shareviews/viewer-doc?docId=&userId=|botIdHash=&days=&shareId=`

The room's viewer drawer can say "Steve opened 1 document in 5m 53s" and no more, because the
viewer aggregate merges a reader's per-document rows and drops the page fields — page 3 of the term
sheet and page 3 of the deck are not the same axis, so "pages viewed" is not a fact about a project.
But a project link writes **one row per (viewer, document)**, so the per-page story still exists on
the individual row; this route goes back for the one that was merged, and the drawer renders it with
the same `PageTimeChart` a document link uses.

A drill-down, not a second source of truth: same collection, same window, same owner-preview
exclusion and the same Pro gate as the drawer it opens from (402 on Basic). An anonymous reader is
addressed by the bare digest and the composite key is rebuilt here (`projectViewerKey`), since the
document is known. Several rows can come back when a reader reached the same document through two of
the project's links; they are summed, as the drawer behind them already summed them. An empty
window answers 200 with zeroes rather than 404 — the reader and the document both exist, the
reading is simply outside the range on screen.

### Visitors who arrived and opened nothing

The room's viewer list is built from `ShareView` — from *reading*. A data room's distinguishing
case is the visitor who opens the front door, reads the file list and leaves: they write a
`ProjectLinkView` row and no `ShareView` row at all, so they were counted in
`totals.landedWithoutOpening` and named nowhere. Someone who introduces themselves and then cannot
find themselves in the room they just gave their name to reads as a broken feature.

`/api/projects/:slug/shareviews` therefore appends arrival-only visitors to `viewers` /
`anonymousViewers`, flagged `openedNothing: true`, with `docsOpened: 0`, no `docs`, and `sessions`
taken from the arrival row's `visits` (they have no `ShareVisit` rows to count). Bounded at 200,
newest arrival first.

**Only those who volunteered an identity.** An anonymous arrival that opened nothing is a number,
and `landedWithoutOpening` is already that number; forty nameless rows would bury the ones a sender
can act on. It follows the same Pro gate as every other viewer identity (`includeViewers`), and the
same owner-preview exclusion as every other figure. The UI says "Opened nothing yet" rather than
"0 documents", which reads like a missing value.

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


## Workspace metrics (`/metrics`)

The workspace-wide overview above the per-document pages (PRD: `docs/prds/lnkdrp-workspace-metrics.md`).
`/doc/:docId/metrics` answers "how is this deck doing"; `/metrics` answers "how is my sharing doing".

### Shape

| Piece | Where |
| --- | --- |
| Endpoint | `GET /api/metrics/workspace?range=7d\|30d\|90d[&fresh=1]` (`src/app/api/metrics/workspace/route.ts`) |
| Aggregation | `src/lib/analytics/workspace/query.ts` — one `$facet` over one index scan |
| Contract + pure helpers | `src/lib/analytics/workspace/{types,range,shape,match}.ts` |
| Page | `src/app/(app)/metrics/{page,pageClient}.tsx` |
| Components | `src/components/workspaceMetrics/` |
| Sidebar entry | "Metrics", directly under Search (`src/components/LeftSidebar.tsx`) |

One request paints the whole page: headline figures with their previous-period deltas, the day
series behind them, the ranked documents / links / people, the quiet documents and the workspace's
own output. There is one loading state and one error state, never a half-filled screen.

### Definitions

Identical to the document metrics page by construction — the same expressions, matched by `orgId`
instead of `docId` (recipients only, bounded by *last activity* in the window, bucketed by UTC day).
**A document's row here must equal its own metrics page for the same range; if they disagree, the
document page is right and this one has a bug** (`tests/lib/workspaceMetricsReconcile.test.ts`
checks exactly that against the seed corpus).

#### Which figures on this page are workspace-scoped and which are document-scoped

A data-room read is the workspace's read and the *project's* view. Both facts are on this page at
once, so the `byDoc` facets count the same buckets twice in one scan (`ownOnly` in `query.ts`):

| Figure | Scope | Why |
| --- | --- | --- |
| Headline **Views / Opens / Reading time / Downloads**, the day series | workspace — every read | The reading happened in this workspace; dropping it here would make this page disagree with its own chart and hide traffic that exists |
| **Top documents** rows (`views`, `viewers`, `opens`, reading time, last opened) | document — project-link reads excluded | The row prints a per-document figure and opens `/doc/:docId/metrics`. A document whose only traffic in the window came through a data room has no row at all; its reading is on the Top links card, under the project link |
| **Top links** rows | per `shareId`, no exclusion | A project link is a row in its own right and opens `/project/:projectId/metrics` |
| **"opened N of M shared documents"**, **Quiet documents** | workspace — every read | These answer "did anyone read this file, anywhere". Excluding data-room reads would put a document a recipient read yesterday into a list headed "shared three weeks ago, nobody has opened it", which is the one wrong answer that makes an owner act |

The visible consequence, and it is intended: the header sentence can say two documents were opened
while Top documents lists one. The missing one is in the data room's row beside it.

#### The four headline figures, and which collection each comes from

| Tile | Means | Source |
| --- | --- | --- |
| **Views** | Recipients active in the window; one person who came back three times is one view | `shareviews`, recipient-only, `activityWindowMatch` |
| **Opens** | Tab sessions in the window | `sharevisits`, one row per session, `lastEventAt >= start` |
| **Reading time** | Foreground time recorded **inside the window** | `sharevisits.timeSpentMs` |
| **Downloads** | Download intents in the window | `shareviews.downloadsByDay` |

Two traps, both of which this page fell into once and now has tests for:

- **Never `viewers` as a headline.** A `ShareView` row is unique per `(shareId, botIdHash)`, so a
  viewer count and a view count are the same number at every level — per workspace, per document and
  per link (measured: 584/584, 40/40, 37/37). The strip shipped "Views 584 · Viewers 584" beside each
  other, and the ranked rows printed "40 viewers … 40 views". `viewers` stays in the payload as the
  reconciliation anchor against the document page; it is not rendered anywhere as a second fact.
- **Never a lifetime counter for a range figure.** `shareviews.timeSpentMs` is cumulative per
  (link, viewer) for the life of the row, so summing it over rows *selected* by activity in the
  window dragged months of earlier reading into a 7-day tile — and onto one point of the chart.
  Range durations come from `sharevisits`, which the document route also exposes as
  `totals.visitTimeMs`.

`opensPartial` carries the one honest caveat: visit rows only exist from the visit-upsert fix
onwards, so on older traffic `opens < views`, which is impossible. When it is set the Opens tile,
the per-row opens figure and the "N readers came back" clause all disappear, exactly as the document
page withholds `totals.opens`.

#### Four figures that are this page's own

- `people.count` — distinct *named* people across the workspace, which is genuinely different from
  any per-link count. The list beside it ranks and prints **in-window** reading time, summed per
  person from `sharevisits`, so the card and the Reading time tile above it are measured the same
  way. It was the last place the lifetime `shareviews.timeSpentMs` survived, and it was wrong there
  too: one seed reader was carried at 148s in a 7-day window of which 60s was read before it. The
  `shareviews` pool is still what *populates* the list, so a reader whose traffic predates visit
  rows keeps their row and simply reads `0` rather than disappearing.
- `docsOpened.returningReaders` — readers with more than one session in the window, grouped per
  `(link, reader)` on the visit rows. **Not `opens - views`**, which is the count of surplus
  *sessions*: on the seed workspace it said 123 where 72 readers came back (77 against 34 at 7
  days), and one reader with 78 sittings would have printed "77 readers came back". It is withheld
  with the rest of the opens family when `opensPartial` is set.
- `docsOpened.shared` follows `getWorkspaceUsage().documents`, so the "12 of 31 shared" sentence and
  the Free document cap count the same documents. Archived and sharing-off documents are still in the
  headline and can still be ranked (their own metrics pages serve them), so `docsOpened.openedOther`
  reports them and the sentence names them rather than being quietly shorter than the list under it.
- `output.docsShared` counts **every live document** whose first link was created in the window —
  the same scope as `linksCreated` and `uploads` beside it in one sentence. There is no
  `Doc.createdDate` fallback: a document with no `ShareLink` has never been shared. Because that
  scope is wider than `docsOpened.shared`, the sentence reads "124 documents got their first link"
  and never "124 documents shared": the two clauses sit four lines apart, and "124 shared" above
  "51 of 104 shared documents were opened" reads as a broken page rather than as two questions.

#### Previous periods

Opens and reading time compare against `sharevisits` in `[prevStart, start)`, which is per-session
and therefore exact. Views has no per-event source: a `ShareView` row holds one `lastViewedAt`, so a
reader active in both periods would vanish from the baseline and inflate the chip. `presenceBetweenMatch`
adds a `createdDate` clause so rows first seen in the previous window stay counted there — a floor
that leans against the rise rather than into it, not a truth. It is why the 7-day chip reads +123.1%
where the naive match said +134.3%.

#### "Gone quiet"

The PRD's rule, not the usage meter's: documents with at least one **enabled, unexpired, unarchived**
link and no recipient activity in the range, dated by that newest live link and held back for
`QUIET_DOC_GRACE_MS` (24h) after sharing. A document whose only link is switched off cannot be
opened by anyone, so nudging its recipient is advice that cannot work; and a header reading "no opens
in 90 days" over eight rows saying "shared 2 hours ago" was both wrong and useless, since the
freshest documents crowded out every genuinely stale one.

### Plan gating

- **Range.** Free is clamped to `FREE_ANALYTICS_DAYS` server-side and told so (`range.clampedByPlan`);
  the control shows 30d and 90d with a lock and opens the upgrade modal for `analytics_history`
  instead of switching. The request always asks for the window the plan actually has, so the
  control, the request and the response describe the same period.
- **Identities.** Pro only ([[viewer identity gate]]). On Free the identity aggregate is never run:
  `people.items` is `[]`, `people.gated` is true, and the section shows the count plus the inline
  `PlanLimitNotice` — the UI has no branch that could render a name it was not given.
- **Deltas.** Free gets no previous period at all (`previous: null`), because comparing the last 7
  days with the 7 before them reads rows outside the window Free is sold. One constant,
  `WORKSPACE_PREVIOUS_ON_FREE` in `range.ts`, if product disagrees. The tiles reserve the chip's
  space either way so the layout is identical on both plans.

### Client notes

- **The range is remembered in `localStorage` (`lnkdrp:metrics:range`), not in the URL** — so the
  page needs no `<Suspense>` boundary and a range change never re-runs the route segment. Read it in
  a mount effect, never during render (reading it in the `useState` initialiser rendered the control
  on "30d" over a 7-day payload). The request waits for that effect *and* for the plan, so a mount
  makes one request rather than three.
- **The plan lock comes from the payload once there is one** — `data.plan.isPro === false ||
  data.range.clampedByPlan`. `usePlan` only fills the gap before the first response: it answers
  `null` with `loading: false` when `/api/plan` fails, which read as "Pro" and left a Free workspace
  with 30d highlighted over a window the server had clamped.
- **`?fresh=1` is per request, not per tab.** It is held in a ref that the realtime handler and the
  Retry button set and the fetch clears; tying it to the refetch counter meant one activity frame
  disabled the 60s cache for the life of the tab, including every later range change.
- **Import types from `src/lib/analytics/workspace/types` in client code, not from the barrel.** The
  barrel re-exports `./range`, which reaches `@/lib/billing/planLimits` and through it Mongoose; the
  first version of the page imported the barrel and the browser bundle threw
  `Cannot read properties of undefined (reading 'OrgMembership')`. `types.ts` imports nothing, which
  is why the range keys/lengths live there beside the type.
- **Realtime is a nudge, not a stream.** A recipient's open arrives as a `share.*` activity frame;
  the page coalesces a burst into one `?fresh=1` refetch ~2s later and skips it while the tab is
  hidden. There is no polling fallback. Note that ingest emits `share.viewed` only when a `ShareView`
  row is *created*, so a returning reader's extra views and time move no frame until something else
  does.
- **Charts are smooth area charts with count labels, never bars** — `valueLabels()` and
  `formatDayKey`, emerald `--chart-views`, first/last labels anchored inward. The date row under the
  plot is HTML, and its tick count follows the measured width (seven on a desktop card, four at 390px).
  The plot's `ResizeObserver` is bound by a **callback ref**, not a mount effect: the measured node
  only exists on the branch that has data, so an effect with `[]` deps ran once against `null` and a
  workspace whose first window was empty never got a plot at all. Count labels use `formatDwell`
  (`1h 22m`), never `formatDwellCompact`, which floors to one unit and printed "1h" on two visibly
  different peaks.

### Scope and indexes

Every pipeline is bounded by `docId: { $in: <this workspace's live documents> }`, which is what
carries tenancy. The `orgId` term beside it is an index hint and is written `{ orgId: { $in: [orgId,
null] } }`: `ShareView.orgId` / `ShareVisit.orgId` default to `null` on rows written before the field
existed (until `scripts/sharelinks-analytics-backfill.ts` runs), and a plain equality silently
dropped that traffic — under-reporting against the very document pages this page links to. Indexes:
`shareviews { orgId, lastViewedAt }` and `sharevisits { orgId, lastEventAt }`, both created by
`db/migration/20260917_0001_shareviews_workspace_window_index.mjs`.

Known limit: the live-document list is materialised in full on every uncached request and embedded as
a `$in` in six pipelines. Invisible at 124 documents; a workspace with tens of thousands would pay a
full collection read. Fixing it means resolving titles for the ranked rows *after* the aggregation
instead of up front — deferred, and deliberately not traded for the `orgId`-only scope above, which
would be a correctness regression.

### Cache

60s TTL, bounded LRU, keyed by `orgId:requestedRange:plan`. The plan is in the key on purpose: a
payload built for Free carries no identities, so serving it after an upgrade — or, worse, serving a
Pro payload to Free — must be impossible. `cache-control: no-store` to the browser; `?fresh=1`
bypasses it for the realtime refetch.
