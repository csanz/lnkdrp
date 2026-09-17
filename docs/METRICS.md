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
  "documents opened" is the same rows' `docsOpened`. The `ShareLink.viewCount` counter a project link
  carries follows the row count, so it reads as *documents opened by recipients* — not landings.
- **`ShareVisit` counts (tab session × document), not tab sessions.** The `visitId` is stored per
  `shareId` in `sessionStorage`, and a project link is one `shareId` for the whole data room, so one
  tab reading two documents writes two rows sharing a `visitIdHash`: *one session in the data room,
  one row per document in it*. Session counts must be `distinct visitIdHash`.
- **Per-document figures are unaffected.** Scoped by `docId`, a viewer still has exactly one row per
  link, which is what the document metrics page already assumes. Its `?byLink=1` breakdown will grow
  project-link slugs beside document-link slugs once a document is shared both ways; they still sum
  to the document total.

Everything else behaves as it does for a document link, deliberately: `isOwnerPreview` is recorded
and never counted, `lastViewedAt` is written only by an ingest, and per-page time comes from the same
`shareTiming` helpers. Verified live on 2026-09-17 — one recipient reading two documents behind one
project link produced two `ShareView` rows, two `ShareVisit` rows with a shared visit id, one
`ProjectLinkView` with both documents, and **nothing at all under either document's own link**.

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
