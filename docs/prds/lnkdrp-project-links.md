# PRD — Project share links and project metrics

**Status:** Draft 2026-09-17 (metis `prd_WQg1rRuLKQ`)
**Owner:** chrissanz
**Last updated:** 2026-09-17
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-multi-links](./lnkdrp-multi-links.md) · [lnkdrp-workspace-metrics](./lnkdrp-workspace-metrics.md) · [METRICS](../METRICS.md)

---

## Problem

A document can have any number of share links, each with its own audience, settings and analytics.
A project — the thing a sender actually sends during a raise, a diligence process or a board
cycle — has exactly one public link (`Project.shareId` → `/p/:shareId`), with no label, no
password, no expiry, no way to revoke one recipient without revoking everyone, and no analytics of
its own. The public page lists the documents and nothing about that visit is recorded the way a
document link's visit is.

So the moment a sender has two audiences for the same set of documents (two funds in diligence,
two counterparties, a board and an advisor), the product forces them back to sending documents one
by one, and they lose the one question a data room exists to answer: **who came, what did they
open, and how long did they spend?**

This is the "spaces / data rooms" case that the multi-links PRD deliberately left out.

## Goal

A project can have any number of share links, each with its own label, audience and settings, each
resolving to the project's public page. Everything a recipient does behind one of those links —
opening the page, opening a document, reading pages, downloading — is attributed to that link, so
the project gets the same quality of metrics a document already has, per link and in total.

## Naming (locked)

The UI keeps calling these **Projects**, not Folders. A document can belong to several projects at
once (`Doc.projectIds`), which is not what a folder means; and the object carries an audience,
links and analytics, which a folder does not.

## Proposed decisions (to lock)

1. **One link model, two kinds.** Extend `ShareLink` with `projectId` and make `docId` optional; a
   row is a document link or a project link, never both. This keeps one public-slug namespace, one
   set of link settings, one search index, one Free-plan counting rule, and lets per-link analytics
   reuse `shareId` exactly as they do today. Every query that assumes `docId` is present is audited
   and scoped to `kind: "doc"`.
2. **The project's existing `shareId` becomes its default link** ("Default link", `isDefault`),
   materialised lazily like `ensureDefaultLink()` does for documents. `/p/:shareId` keeps resolving
   for every link that exists today. No migration day.
3. **Per-link settings:** `label`, `audience`, `enabled`, `password`, `expiresAt`, `allowDownload`.
   Download applies to every document opened through that link. The document's own link settings do
   not apply when a recipient arrives through a project link; the project link's settings govern.
4. **Contents follow the project.** A link exposes the project's current, non-archived documents.
   Choosing a subset per link is future work, called out on the page so nobody assumes otherwise.
5. **Documents open under the project link.** A recipient opening a document from the project page
   goes to `/p/:shareId/:docId`, which renders the existing viewer with the project link's
   `shareId`. Every existing `ShareView` / `ShareVisit` mechanism (unique viewer, per-page reading
   time, per-visit sessions, downloads) then records under that link, keyed by its `shareId` and
   the document's `docId`, with no new timing code.
6. **The project page visit is tracked too.** A new `ProjectLinkView` (keyed `shareId` +
   `botIdHash`, the same identity rule as `ShareView`) records landings on the project page:
   first/last seen, visit count, documents opened, downloads. `ProjectView`/`ProjectClick` stay as
   they are for internal (signed-in) viewers; they are not the public path.
7. **Plan gating.** Project links are a Pro feature. Free keeps its single default project link,
   unchanged, and sees the upsell when it tries to add another. Rationale: this is the data-room
   feature, the clearest Pro trigger after multi-links, and the Free cap counts shared documents
   rather than links.
8. **Metrics live on the link, and roll up.** A project metrics page (`/project/:slug/metrics`,
   reached from the project header) shows, for the selected range: Views, Opens, Reading time,
   Downloads for the whole project; a per-link breakdown; a per-document ranking (opened, reading
   time, viewers) inside the project; the people (Pro); and documents nobody opened. Definitions
   are the locked ones in the workspace metrics PRD, so figures reconcile everywhere.
9. **The project header adopts the standard header.** `AppPageHeader` with the folder icon, the
   project name (rename in place), the description, the "Request link" badge where it applies, and
   actions for the document count, Links and Metrics. Same band as Search, Upload, Activity and
   Metrics.
10. **The MCP gets the same reach it has for document links** — create, list, update, delete
    project links — since an agent assembling a data room is the reason this exists. Destructive
    calls confirm with the human, like the document ones.

## Approach

- `src/lib/share/links.ts` grows project-link creation/lookup beside the document one, with the
  audit of `docId`-assuming call sites done first and listed in the PR.
- `/p/:shareId` resolves a `ShareLink` of kind project (falling back to `Project.shareId` until the
  default row exists), enforces enabled/expiry/password with the existing share-auth cookie, and
  renders the document list. `/p/:shareId/:docId` renders the viewer bound to that link.
- Ingest: the viewer already posts to `POST /api/share/:shareId/stats`; it needs to accept a
  project link's `shareId` and record against the document being read.
- Metrics reuse `src/lib/analytics/workspace/` helpers (ranges, deltas, ranking) and add a
  project-scoped query; the UI reuses the workspace metrics components.
- Free-plan counting stays "shared documents", so a project link does not multiply the count.

## Non-goals (v1)

- Choosing a subset of documents per link, or per-document permissions inside a project.
- NDA click-through, watermarking, one-time links, per-viewer email verification beyond what
  documents already do.
- Folders/nesting, or renaming Projects to Folders.
- Bulk link creation from a CSV.
- Public project pages for request repos (they keep their own upload flow).

## Milestones

### M1 — Project links, model and API
- Audit every docId-assuming ShareLink call site and scope them to document links
- ShareLink gains projectId with optional docId; default project link materialised lazily from Project.shareId
- CRUD API for project links (create, list, update, disable, delete) with Pro gating
- Unit tests for link resolution, expiry, password and the default-link fallback

### M2 — Public project link experience
- /p/:shareId resolves a project link: enabled, expiry, password gate, disabled states
- /p/:shareId/:docId renders the document viewer bound to the project link
- Stats ingest accepts a project link shareId and records ShareView/ShareVisit per document
- ProjectLinkView records landings, visits and documents opened on the project page

### M3 — Project links UI and the standard header
- Project page header moves to AppPageHeader with name, description, badge and actions
- Links panel on the project page: create, label, audience, copy, password, expiry, download, disable
- Free sees one link and the upsell when adding another
- Empty, loading and error states; 390px and light/dark verified

### M4 — Project metrics
- GET /api/projects/:projectId/metrics: range, per-link breakdown, per-document ranking, people (Pro)
- Project metrics page reusing the workspace metrics components and locked definitions
- Reconciliation test: project totals equal the sum of their links and match document metrics
- Workspace Metrics page gains a Top projects section

### M5 — MCP and docs
- MCP tools: create, list, update and delete project links, with human confirmation on destructive calls
- docs/METRICS.md and docs/MCP.md updated; DEPLOY.md notes any index or migration

## Verification

- A project with two links: each records its own viewers, and a document opened through link A
  never appears under link B.
- Password, expiry and disable each refuse the page, and refuse `/p/:shareId/:docId` directly.
- Reading time and sessions recorded through a project link match what the same visit records
  through a document link (verified live, the way document tracking was verified on 2026-09-17).
- Free: one link, upsell on the second; no viewer identities anywhere in Free payloads.
- `tsc`, `eslint` (0 errors), vitest suites, screenshots at 1440 and 390 in light and dark.

## Open questions

- Should a project link's password be per link only, or should the project also support a single
  password that every link inherits? (Draft: per link only.)
- When a document is removed from a project, do links keep showing it until the page is reloaded?
  (Draft: contents are resolved per request, so it disappears immediately.)
- Do we show recipients the project description and a cover, or keep the page as a bare list?

## Future

- Per-link document subsets and per-document permissions.
- Data-room extras: NDA acceptance, watermarking, granular expiry per document.
- A per-person page across a project's documents.
- Weekly digest for a project ("who came this week").
