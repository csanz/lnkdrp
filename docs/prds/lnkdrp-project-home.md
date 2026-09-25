# PRD — A document's home project (upload into a room, and stay inside it)

**Status:** Draft 2026-09-25, decisions 1–9 proposed. M1 built the same day: `POST /api/docs { projectId, visibility }` (400 `PROJECT_NOT_FOUND` / `PROJECT_IS_INBOX` / `VISIBILITY_NEEDS_PROJECT`), the created row carries `projectIds` + `primaryProjectId` from the first write, `doc.created` and `doc.processed` rows say "in <room>" and filter to it, the Slack "was added to <room>" post routes to the room's channel; `lnkdrp_share_pdf { projectId | projectSlug }`; the upload page's data-room picker with `?project=` preselect and a project page "Upload here" button. M2 built the same day: `Doc.visibility`, `workspaceListableDocFilter()` spread into every workspace-wide listing (pinned by `tests/lib/containedDocListings.test.ts`), the feed rule (`/api/activity` leaves contained rows out; `?projectId=` shows them), the Slack rule (`routeSlackConnections` with `allowDefault: false`), `PATCH /api/docs/:id { visibility }` with `VISIBILITY_NEEDS_PROJECT` and the 409 `CONTAINED` refusal, `doc.contained` / `doc.uncontained` feed rows, list rows and `GET /api/docs/:id` carry `primaryProjectId` and `visibility`. M3 built the same day: the "Only inside this data room" checkbox on the upload page, the Contained pill and the menu toggle on the document page, `lnkdrp_set_doc_visibility` and the MCP read-back, FEATURES.md and CHANGELOG. Proved end to end on the local data room (create into the room over the MCP: one event, one Slack post to the room; contained: absent from the workspace list, sidebar and feed, present in the room list and the room feed; second room refused; listed again on request).
**Owner:** chrissanz
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-project-links](./lnkdrp-project-links.md) · [lnkdrp-slack](./lnkdrp-slack.md) · [lnkdrp-enterprise](./lnkdrp-enterprise.md) · [FEATURES](../FEATURES.md)

---

## Problem

A document is born in the workspace and moved into a project afterwards. Every surface learns
about it in that order: the feed says "Acme cap table was added" and then, a moment later, "Acme
cap table was added to Data room"; Slack posts the first line to the catch-all channel and the
second to the room's channel; the sidebar's Docs list shows it from the first second. For a deck
that was always meant for one data room, that first moment is noise at best. Once projects can
be private (the enterprise PRD's direction), it is a leak: a document that will live inside a
restricted room has already been announced to the whole workspace.

Two things follow. A document should be able to start life inside a project, so the first and
only creation event is already scoped to it. And a document should be able to live only inside
its project: listed there, searched there, its activity read there, and nowhere else in the
workspace. The second is what makes a private project possible later; the first is what makes it
clean.

## Goal

- A person uploading from the upload page, from a project's page, or an agent calling
  `lnkdrp_share_pdf`, can name the project the document goes into. The document is in the
  project from the moment it exists; the feed records one row ("… was added to Data room") and
  Slack posts once, to the room's channel.
- A document can be marked **contained**: it appears only inside its home project. The Docs
  sidebar, `/api/docs`, search, tag pages, the home dashboard, workspace-level metrics lists and
  the MCP's `list_docs` and search leave it out. The project's own page, metrics and links show
  it as before. Its activity rows appear when the feed is filtered to that project and not in the
  workspace-wide feed. Its Slack posts go to the project's channel or nowhere, never to the
  catch-all.
- Both settings are visible and reversible on the document, and readable over the MCP.

## Non-goals (v1)

- Private projects themselves (who may open the project). This PRD makes a document containable;
  membership on a project is the enterprise PRD's job and lands on top of it.
- A document in more than one project while contained. A contained document has one home.
- Moving a document between projects with history rewriting. Moving keeps the history.
- Hiding a contained document from workspace **admins and owners** on a direct URL. Containment
  is about listing and announcement, not access; access control comes with private projects.
- Request inboxes. A file received through a request inbox already carries its inbox
  (`receivedViaRequestProjectId`); that path is unchanged and is not "contained" by default.

## Proposed decisions (to lock)

1. **A document has at most one home project.** The existing `Doc.primaryProjectId` is the home
   (no new field): the schema already keeps `projectIds` as the membership list and
   `primaryProjectId` as the one the document belongs to, and `addProjectId` already sets it on
   the first join. What is new is setting it at creation (upload page picker, a project page's
   "Upload here", `lnkdrp_share_pdf { projectId | projectSlug }`, `POST /api/docs { projectId }`). A document created into a project has both from the first
   write, before processing starts, so every consumer that runs during or after processing (the
   feed, Slack, the sidebar snapshot, the realtime frame) sees it inside the room.

2. **One creation event, in the room.** Creating into a project records `doc.created` and
   `doc.processed` with `projectId` set, and no `doc.added_to_project` row. The sentence reads
   "… was added to Data room". Slack's "New documents" post for a created document routes on the
   home project like every other event: the room's channel when mapped, else the catch-all
   (decision 6 narrows this for contained documents). The process route posts `created` once with
   `projectId`; the PATCH route's `added_to_project` post is for documents that were not born
   there.

3. **Containment is a document setting.** New field `Doc.visibility: "workspace" | "project"`,
   default `"workspace"`. `"project"` requires a `primaryProjectId`; setting it without one is a 400.
   Set at creation (`lnkdrp_share_pdf { projectId, visibility: "project" }`, an "Only inside this
   room" checkbox under the upload page's project picker, on by default when uploading from a
   project page whose setting says so) and on the document afterwards
   (`PATCH /api/docs/:id { visibility }`, owner or admin, or the uploader). Clearing it back to
   `"workspace"` is allowed the same way. A contained document refuses `addProjectId` to a second
   project (409 `CONTAINED`) until it is made workspace-visible.

4. **Where a contained document is not.** Every workspace-wide listing excludes
   `visibility: "project"`: `GET /api/docs` (and `lite`), the sidebar snapshot's docs and recents,
   `/api/search`, tag pages, starred, the home dashboard's recent and top lists, workspace
   metrics rollups and top-document tables, `lnkdrp_list_docs`, `lnkdrp_search`. The exclusion
   is one shared filter (`workspaceListableDocFilter()` in `src/lib/docs/visibility.ts`) so a new
   listing cannot forget it, and a source-contract test pins every listing to the helper.
   Listings inside the project (the project page, `/api/projects/:slug/docs`, project metrics,
   project links, the public data-room page) are unchanged.

5. **Where its activity is.** `GET /api/activity` without a `projectId` filter excludes rows
   whose `docId` is a contained document (a `$nin` over the workspace's contained ids, cached per
   request; a workspace has few). With `projectId` set to the home project, they show. The
   realtime feed frame carries `containedIn: <projectId>` for those rows so an open workspace
   feed can drop them client-side. Email notifications are unchanged in v1 (they go to members,
   who can open the project); private projects will revisit this.

6. **Slack: the room's channel or nowhere.** For a contained document, `routeSlackConnections`
   is given the home project only and the catch-all fallback is off: mapped room → that channel,
   unmapped room → no post. The catch-all exists so nothing is lost; for a contained document,
   "lost" is the point.

7. **Direct URLs still work for the workspace.** `/doc/:id`, its metrics, history and links stay
   reachable by any workspace member who has the URL, as today. What changes is discovery.
   Search-by-title from the command palette inside the project still finds it. The document
   page shows a **Contained** pill next to the project pill so a person understands why it is
   absent from the sidebar.

8. **The MCP reads it back and sets it.** `lnkdrp_share_pdf` gains `projectId` / `projectSlug`
   (one of them) and `visibility`. `lnkdrp_get_share`, `lnkdrp_list_docs` rows and
   `lnkdrp_get_project` document rows carry `homeProjectId` and `visibility`.
   `lnkdrp_add_docs_to_project` answers `CONTAINED` for a contained document, and a new
   `lnkdrp_update_doc { visibility }` (or `lnkdrp_set_doc_visibility`) sets it. `lnkdrp_whoami`
   capabilities say nothing new: available on every plan.

9. **Plan and limits.** Every plan. Containment does not change document counts or caps.

## Approach

- **Model.** `Doc.primaryProjectId` (exists), `Doc.visibility` (new, indexed) for the exclusion. `src/lib/docs/visibility.ts` exports `workspaceListableDocFilter()`
  (`{ visibility: { $ne: "project" } }`), `containedDocIds(orgId)` (cached per request) and
  `assertCanContain(doc)`.
- **Creation into a project.** `POST /api/docs` and the upload-url / import-url routes accept
  `projectId` (validated: same org, not a request inbox, not deleted); the created row carries
  `projectIds: [p]`, `homeProjectId: p`, and `visibility` when asked. The process route's first-
  version completion records the feed rows with `projectId` and posts Slack once. The MCP client
  passes `projectId` through `createDoc`.
- **UI.** Upload page: a project picker (rooms only, not inboxes) with "Only inside this room"
  under it; a project page: "Upload here" opens the same flow with the project fixed. Document
  page: the project pill shows the home; a **Contained** toggle for owners/admins.
- **Listings.** Apply the filter at every site decision 4 names; pin with
  `tests/lib/containedDocListings.test.ts` (source contract over the listing routes).
- **Activity.** Feed API and realtime frame per decision 5. Sentence helpers unchanged.
- **Slack.** `enqueueSlackPosts` reads the document's `visibility`; contained → route with
  `{ projectIds: [home], allowDefault: false }`.

## Verification

1. Upload from the upload page with a project chosen: the feed shows one row, "… was added to
   Data room"; Slack posts once, to the room's channel; the document is in the room's list.
2. `lnkdrp_share_pdf { projectSlug }`: same, from the MCP; `lnkdrp_get_project` lists it.
3. A contained document does not appear in the sidebar Docs list, `/api/docs`, search, the
   dashboard, workspace metrics or `lnkdrp_list_docs`; it appears on the project page and in
   project metrics; its direct URL opens.
4. The workspace feed hides its rows; the feed filtered to the project shows them.
5. A contained document in an unmapped room posts nothing to Slack; in a mapped room it posts
   there.
6. `addProjectId` to a second project answers 409 `CONTAINED`; after `visibility: "workspace"`
   it succeeds and the document is listed again.
7. The source-contract test fails when a listing route stops using the shared filter.

## Milestones

**M1 — Upload into a project.** Model field `homeProjectId`, `projectId` on document creation
(API, upload page picker, project page "Upload here", `lnkdrp_share_pdf`), one creation event
with `projectId`, Slack routes it to the room. Fixes the "main activity first" ordering.

**M2 — Contained documents.** `visibility`, the shared filter across every listing, the feed
rule, the Slack rule, `PATCH { visibility }`, the MCP fields and tool, the source-contract test.

**M3 — Surfaces and docs.** Upload checkbox, document-page pill and toggle, project-page
setting for the default, FEATURES.md, MCP.md, CHANGELOG.

## Open questions

1. Should a project carry a default ("new documents here are contained") so a room can be set
   once? Proposed: yes, `Project.containNewDocs: boolean`, M3.
2. Should a contained document's **view emails and briefs** go only to members of the project
   once projects have members? Deferred to the private-projects PRD; today every member.
