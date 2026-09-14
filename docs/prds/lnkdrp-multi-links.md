# PRD — Multiple share links per document

**Status:** Approved 2026-09-13, in progress (metis `prd_Po4aqWpRh3`; M1–M3 building)
**Owner:** chrissanz
**Last updated:** 2026-09-13
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-mcp](./lnkdrp-mcp.md) · [lnkdrp-plan-limits](./lnkdrp-plan-limits.md) · [lnkdrp-enterprise](./lnkdrp-enterprise.md) · [METRICS](../METRICS.md)

---

## Problem

A document has exactly one share link. The link *is* the document's sharing state: one
password, one download switch, one set of viewers. That breaks the moment a sender has more
than one audience for the same file:

- A founder sends the deck to twelve investors. Today they either send the same link to
  everyone and lose the ability to say which firm opened it, or upload the deck twelve times.
- Legal sends the same agreement to two counterparties and wants to revoke one side's access
  without touching the other.
- An agent asked to "create an exclusive link for Sequoia" has no way to express that; it
  can only return the document's link.

Per-recipient links are the core mechanic of the category (DocSend's "unique link per
investor, toggle access investor by investor"; Papermark's "each link has its own settings").
lnkdrp's analytics are already keyed by `shareId`, so most of the value is unlocked by letting
one document own many `shareId`s.

## Goal

Let a document have any number of share links, each with its own label, audience, settings and
analytics, without re-uploading the file, from the web app and from the MCP. Existing links keep
working unchanged.

## Non-goals (v1)

- Spaces / data rooms (many documents behind one link). Separate PRD.
- Mail-merge bulk link creation from a CSV. Future.
- Per-link watermarking, NDA click-through, or one-time-view links.
- Link presets shared across the workspace. Future (Papermark has them; low cost once links exist).
- Changing the public URL scheme. `/s/:shareId` stays.

## Proposed decisions (to lock)

1. **A share link is its own record** (`sharelinks` collection), not a field on the document.
   The document keeps `shareId` only as a pointer to its *default link*; every existing
   `shareId` is migrated into a link row labelled "Default link". No user-visible change on
   migration day.
2. **Per-link settings, minimal set:** `label`, `audience` (free text, e.g. "Sequoia · Roelof"),
   `enabled`, `allowDownload`, `password`, `allowRevisionHistory`, `expiresAt`. Everything the
   doc-level share panel offers today, plus expiry. Settings the document had are copied into the
   default link on migration and the document-level fields stop being read.
3. **Plan limits stay literal.** The Free cap is "3 active share links" and now means exactly
   that: enabled, unexpired links across the workspace, whichever documents they belong to. Pro
   is unlimited. Multiple links per document is therefore usable on Free (three investors on one
   deck) and is the clearest Pro trigger in the product. Archiving a document or disabling a link
   frees a slot, as today.
4. **Per-link analytics for free, per-link identity on Pro.** Views, downloads and viewer
   counts are already keyed by `shareId`; the metrics page gains a link filter. Names and emails
   per link follow the existing deep-analytics rule (Pro).
5. **Require-email on a link is Pro**, and is the bridge to Enterprise "verified access": v1
   asks for an email before viewing; verification-by-magic-link is a later milestone.
6. **Agents get it on day one.** `lnkdrp_create_share_link`, `lnkdrp_list_share_links`,
   `lnkdrp_update_share_link` join the MCP, and `share_pdf` returns the default link exactly as
   now. "Create an exclusive link for Sequoia and use it in the email" is the launch demo.
7. **Abuse guard:** at most 50 links per document and 200 per workspace on Pro (raise on
   request); creation is rate-limited per key.

## Approach

### Data model

`sharelinks` (new): `{ orgId, docId, shareId (unique slug, same generator as today), label
(≤ 80), audience (≤ 120, nullable), enabled, allowDownload, passwordHash, allowRevisionHistory,
expiresAt (nullable), isDefault, createdByUserId, createdVia: "web"|"api"|"mcp", createdDate,
updatedDate, archivedAt, lastViewedAt, viewCount, downloadCount }`. Indexes: `shareId` unique;
`{ orgId, docId }`; `{ orgId, enabled, expiresAt }` for the cap count.

`Doc`: keep `shareId` (default link pointer) and `shareEnabled` (derived: any enabled link) for
one release; stop reading `shareAllowPdfDownload`, `sharePasswordHash`,
`shareAllowRevisionHistory` from the document after migration. `ShareView` / `ShareVisit` /
`DocPageTiming`: add `shareLinkId` (ObjectId) beside `shareId` for joins; `shareId` stays the
analytics key. All three also carry `orgId` (denormalized tenancy) on `ShareView` / `ShareVisit`, so
workspace-level analytics is an indexed scan rather than a `$lookup` into `docs`. `shareLinkId` is
written with `$set` (never `$setOnInsert`) so a pre-existing row self-heals, and
`scripts/sharelinks-analytics-backfill.ts` fills the rows nobody visits again — a null join handle is
worse than no field, because a query written as `{ shareLinkId }` then returns a plausible fraction
of the truth. On `DocPageTiming` the link dimension only ever applies to a workspace member reading
through a link: a public share visitor cannot write that collection, and its per-page external
equivalent is `ShareView.pageTimeMsByPage` / `ShareVisit.pageTimeMsByPage`.

**Status of the `DocPageTiming` link dimension: schema and ingest done, emitter NOT done.** The
fields, the indexes, the `POST /api/metrics/events` handling and the client helper
(`trackDocPageTiming`) are in place and verified end to end, but nothing calls the helper: the only
surface that reads a document page in-app is the owner doc viewer, and `docpagetimings` is empty. So
`/history/:version/recipients` still answers `opened: false` for everyone, and "how did the
recipients of the Sequoia link read v3" cannot be answered yet. Do not mark this requirement
satisfied until a reader calls `trackDocPageTiming` with the slug it was opened through.

### Resolution

`/s/:shareId`, `/s/:shareId/pdf|changes|og.png`, `/api/share/:shareId/*`: resolve
`ShareLink.findOne({ shareId })` → its doc; refuse when `!enabled`, `expiresAt < now`, doc
archived/deleted. One helper `resolveShareLink(shareId)` replaces the 11 inline
`DocModel.findOne({ shareId })` lookups. Passwords use the link's hash; the unlock cookie is
scoped per `shareId` (already).

### Plan limit

`getWorkspaceUsage().activeLinks` counts `sharelinks` with `enabled && !archivedAt &&
(expiresAt == null || expiresAt > now)`. `checkLimit("active_links")` runs on link creation and
on enabling a disabled link. `share_pdf` and upload create the default link through the same
path, so the cap behaves exactly as today for single-link documents.

### Web app

- Doc page share panel becomes **Links**: a list (label, audience, `/s/…`, copy, status pill
  Enabled / Disabled / Expired / Password, views · viewers · last viewed) with the default link
  first. **New link** opens a modal: label, audience, settings, "Copy settings from…" (another
  link). Row actions: copy, edit settings, disable/enable, delete (soft-archive; analytics kept).
- Metrics page: link filter chip row (All · each link), and a per-link table (views, unique
  viewers, downloads, last viewed) above the viewer list. Quick stats show links count and the
  top link.
- Sidebar meter and upsells unchanged in shape; the counted unit is now links, and the
  `active_links` modal copy says "Free workspaces can have 3 active share links across all
  documents".
- Share page: no visible change. OG image per link identical to the document's.

### API and MCP

REST (key or session): `GET/POST /api/docs/:docId/links`, `PATCH/DELETE /api/docs/:docId/links/:linkId`,
`GET /api/docs/:docId/shareviews?shareId=…` (filter). `PATCH /api/docs/:docId` share fields keep
working by writing to the default link (compat for one release, then 410).

MCP: `lnkdrp_create_share_link { docId, label, audience?, allowDownload?, password?, expiresAt?,
allowRevisionHistory? } → { linkId, shareId, shareUrl, … }`; `lnkdrp_list_share_links { docId }`;
`lnkdrp_update_share_link { linkId, enabled?, … }`; `lnkdrp_get_share_stats` accepts `shareId`
already and now reports per link. `lnkdrp_set_share_access` keeps its contract and targets the
default link.

### Activity and realtime

New activity types `share_link.created`, `share_link.updated`, `share_link.revoked` (label in
meta; agent attribution as usual). `share.viewed` / `share.downloaded` meta gains
`linkLabel` so the feed reads "Someone viewed USAVX MEMO via Sequoia link". The realtime
`activity` frame carries these through with no server change.

### Migration

1. Deploy code that reads links but still falls back to `Doc.shareId` when no row exists.
2. Backfill script: one `sharelinks` row per document from its current fields
   (`isDefault: true`, label "Default link"), idempotent, dry-run first (`db/migration/`).
3. Flip reads to links-only; keep the doc fields for one release as a safety net.
4. Remove doc-level share fields from writes.

Rollback: the previous build ignores `sharelinks` and reads the still-present doc fields.

## Verification

1. A document with three links: each resolves, each password gates independently, disabling
   one leaves the others working, expiry refuses at the second.
2. Free workspace: third enabled link anywhere in the workspace hits the cap with the standard
   modal; disabling a link on another document frees a slot.
3. Metrics filtered by link show only that link's viewers; the document total equals the sum.
4. `lnkdrp_create_share_link` from Claude Code creates a labelled link that appears in the doc
   page within a second (realtime) and in Activity attributed to Claude Code.
5. Migration on the dev database leaves every existing `/s/:shareId` working and every doc's
   quick stats unchanged.

## Milestones

### M1 — Model, migration, resolution (no UI change)
- `ShareLink` model, `resolveShareLink`, all share routes on it, backfill migration, cap counts links.
- Proves: nothing visible changed; tests for resolution, cap and migration idempotency.

### M2 — Links in the app
- Share panel → Links list + New link modal; metrics link filter; quick stats; activity types; upsell copy.
- Proves: verification 1–3.

### M3 — Agents
- Three MCP tools + REST routes; `docs/MCP.md`, public guides' tool catalog; e2e step.
- Proves: verification 4.

### M4 — Pro link security
- `expiresAt` UI, require-email gate (Pro), later magic-link verification (Enterprise "verified access").

## Decided (were open questions)

1. The document's share toggle stays and becomes "enable/disable every link" (`setAllLinksEnabled`).
2. The Free cap counts every active link across the workspace; `/pricing` already says
   "3 active share links", so no copy change. Three investor links on one deck use the whole
   Free cap by design: that is the clearest Pro trigger in the product.
3. Link labels and audience notes are never shown to a viewer, anywhere.
4. No per-link OG image or title in v1.

## Future

- Link presets; bulk "one link per row" from a pasted list of names/emails; a link per
  recipient generated by an agent from a CRM; Spaces (several documents behind one link);
  per-link NDA / watermark; verified access via magic link (Enterprise).
