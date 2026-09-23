# PRD — Tags

**Status:** Approved 2026-09-18, building (metis `prd_5sIwl5b01z`)
**Owner:** chrissanz
**Last updated:** 2026-09-17
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-project-links](./lnkdrp-project-links.md) · [lnkdrp-workspace-metrics](./lnkdrp-workspace-metrics.md) · [lnkdrp-multi-links](./lnkdrp-multi-links.md)

---

## Problem

A workspace has two ways to organise today, and neither answers "show me everything to do with
fundraising".

- **Projects** are containers you send: a document can belong to several (`Doc.projectIds`), and
  each project will soon carry its own links and metrics. They are places, with an audience.
- **AI tags** already exist and nobody knows it. Every AI summary writes them
  (`aiOutput.tags` — a memo in the dev corpus carries "drones", "defense technology", "autonomous
  systems"), there is a read-only API to list documents by one (`GET /api/tags/:tag/docs`), and
  they appear nowhere a person can act on them. They cannot be edited, added, removed or applied to
  a project.

So a sender who works in themes — a raise, a diligence process, a customer segment — has no way to
label across projects, and no way to ask how a theme is doing. The one cross-cutting question the
metrics work now makes answerable ("how is fundraising doing this quarter?") has no input.

## Goal

A workspace-level tag any member can create and apply to documents **and** projects, so a theme can
be labelled once and then filtered, browsed and measured — including by an agent over the MCP,
which is the version of tagging that survives past week two.

## Why tags and not categories

A category forces one bucket per item and starts an argument about the list. Tags are additive: the
same deck is "fundraising", "series-a" and "confidential" at once. Categories earn their keep only
when something downstream depends on exactly one value (pricing, routing, permissions), which is not
the case here.

## Proposed decisions (to lock)

1. **A tag is a workspace object**, not a string on a document: `Tag { orgId, name, slug, color,
   createdBy, createdDate }`, unique on `(orgId, slug)` with slug folded for case and accents (the
   same rule project names already use). Renaming a tag renames it everywhere; merging two tags is
   one operation, not a find-and-replace.
2. **Applies to documents and projects**, many per item, through one join collection
   `TagAssignment { orgId, tagId, targetKind: "doc" | "project", targetId, createdBy }`, unique on
   `(tagId, targetKind, targetId)`. One collection keeps "everything tagged fundraising" a single
   indexed query across both kinds.
3. **Free text at the point of use, with autocomplete.** Typing offers existing tags first and
   creates on Enter when nothing matches. Without autocomplete a workspace grows "fundraise",
   "Fundraising" and "fund-raising" inside a month.
4. **Rename, merge and delete** live in one small manage screen (`/dashboard?tab=workspace` or a
   tags modal from search). Merge is what keeps tags usable after a year, and it is cheap while the
   data model is one join collection.
5. **AI tags become suggestions, not tags.** The document page shows `aiOutput.tags` as greyed
   suggestions with a "+"; accepting one creates or attaches the real tag. Nothing else in the
   product reads `aiOutput.tags` after this. Two different things called "tags" is the one way this
   feature gets confusing, and this settles it.
6. **Links are not tagged (v1).** A link already carries a label and an audience, and tagging links
   would make the metrics rollups ambiguous (a document opened through two links with different
   tags). Tag the document and the project; the link inherits nothing.
7. **Where tags appear:** a chip row under the title on the document page and the project page
   (click to filter), a `tag:` filter and facet in Search, a tag page listing the documents and
   projects that carry it, and a tag filter on Metrics.
   **In the sidebar, a tag is a coloured dot, not a pill** (decided 2026-09-18 from
   `/style-guide/tags`, which put both at the sidebar's real width): a pill reads instantly but
   costs name width, and it stops fitting exactly when tags become useful — two tags turned
   "Quarterly updates" into "Q…". Up to three dots sit before the document count, names in the
   tooltip, and a **Tags section** below Projects lists each tag with its count, which is what
   makes a colour legible. Full pills everywhere with room: document and project pages, search
   results, modals. **The Tags section is collapsed by default**, with its count in the header
   ("Tags 5") so it is still discoverable — the sidebar already carries Starred, Projects and Docs,
   and a fourth open list pushes documents below the fold. It expands on its own when a tag page or
   a tag filter is open, and the choice is remembered per browser like the other sections.
   **Colour is auto-assigned from a small palette and can be changed per tag** — effortless by
   default, and durable ("green is fundraising") for anyone who cares to set it.
8. **A tag's page is search, scoped.** `/tag/:slug` shows the rollup for the range (Views, Opens,
   Reading time, Downloads across everything carrying it) above the projects and documents that
   carry it — built on Search's query and row components, not a parallel listing, so the page and
   `search?tag=` can never disagree. Documents in no project appear there too, which is half the
   point of tags.
9. **Metrics by tag is the payoff.** The workspace Metrics page gains an optional tag filter, so
   "fundraising: 340 views, 6 documents, 22 minutes read this month" is one click — a rollup across
   projects that no project could give. Uses the locked definitions; the tag filter resolves to a
   document id set and reuses the existing aggregation.
10. **Plan gating: tags are free; tag-scoped metrics are Pro.** Organising should never be
   paywalled. Analytics depth is already where the Free/Pro line sits, so tag filtering on Metrics
   follows `analytics_history`.
11. **Agents get the full surface:** `lnkdrp_list_tags`, `lnkdrp_tag` and `lnkdrp_untag`
    (documents and projects), plus a `tags` field on the existing list/get tools and a `tag` filter
    on `lnkdrp_list_docs`. An agent that files every incoming document is how tags stay accurate.

## Approach

- Models `Tag` and `TagAssignment` with the indexes above; no array on `Doc`, so renames and merges
  are one write and "what is tagged X" stays indexed.
- `src/lib/tags/` owns create/attach/detach/rename/merge/list plus the name-folding rule, with unit
  tests; routes stay thin.
- A shared `TagInput` (autocomplete, create-on-Enter) and `TagChips` used by the document page, the
  project page and search, so the three surfaces never drift.
- Search gains `tag:` parsing and a facet; the tag page is a thin view over the same query.
- Metrics: an optional `tagId` resolves to the document id set that already bounds every workspace
  aggregation, so the tag filter costs one extra lookup and no new pipeline.
- Backfill: none. Existing AI tags stay where they are and surface as suggestions.

## Non-goals (v1)

- Hierarchy, nested tags or namespaces. Projects already cover "things that belong together"; this
  is where tagging systems go to die.
- Tagging share links, versions or viewers.
- Per-tag permissions or sharing a tag with a recipient (tags are private to the workspace).
- Automatic tagging without a human or an agent asking for it.
- Colour theming beyond a small fixed palette.

## Milestones

### M1 — Model and service
- Tag and TagAssignment models with unique indexes and the folded-slug rule
- src/lib/tags service: create, attach, detach, rename, merge, list, with unit tests
- REST: list/create tags, attach/detach for a document or a project, rename/merge/delete

### M2 — In-product tagging
- TagInput with autocomplete and create-on-Enter, plus TagChips, as shared components
- Tag chips and editing on the document page and the project page
- AI tags shown as suggestions with accept, and nothing else reading aiOutput.tags
- Manage tags screen: rename, merge, delete, with usage counts

### M3 — Finding things by tag
- Search: tag: filter, facet and chips, on documents and projects
- A tag page listing the documents and projects carrying it
- Sidebar entry point to tags (hover control on a section header, matching Docs and Projects)

### M4 — Tag metrics and agents
- Optional tag filter on the workspace Metrics page and its endpoint (Pro)
- MCP: list_tags, tag, untag; tags on list/get responses; tag filter on list_docs
- docs/MCP.md, docs/METRICS.md and DEPLOY.md notes for the new indexes

## Verification

- A tag applied to a project and a document appears on both, filters search, and rolls up in
  Metrics to the same numbers those documents show individually.
- Rename and merge update every surface with no orphan assignments; deleting a tag never deletes a
  document.
- Free: tagging works; the Metrics tag filter shows the upgrade prompt.
- An agent can list, apply and remove tags, and `list_docs?tag=` returns exactly the tagged set.
- `tsc`, `eslint` (0 errors), vitest, screenshots at 1440 and 390 in light and dark.

## Open questions

- **Locked 2026-09-18: independent.** A tag on a project does not propagate to its documents; a
  project holds documents that are not all about the same theme, and inheritance makes "untag this
  one document" impossible to express. A tag page therefore lists the tagged project *and* the
  documents that carry the tag themselves.
- Should the AI suggest tags from the workspace's existing vocabulary rather than free text, once
  there is a vocabulary to suggest from?
- **Locked 2026-09-18:** auto-assigned from a fixed palette, changeable per tag.

## Future

- Saved views ("fundraising, last 30 days") pinned in the sidebar.
- Tag-scoped digests: what happened in "fundraising" this week.
- Suggesting a tag when a document is added to a project that is heavily tagged.
- Per-tag retention or expiry rules for links carrying sensitive themes.
