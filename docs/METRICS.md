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

## Best-effort caveats / interpretation notes

- **Time spent** counts **foreground time only** (we avoid counting hidden tab time).
- **Session/visit boundaries** are best-effort (per-tab sessionStorage).
- **Revisit counts** are derived from page segments recorded; they’re a signal, not ground truth.
- Clock skew can exist between client and server; we clamp/validate timestamps to reduce abuse.

