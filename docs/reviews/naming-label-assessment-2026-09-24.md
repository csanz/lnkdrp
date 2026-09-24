# Naming assessment: "label", "tag", and what each thing should be called

**Date:** 2026-09-24. **Question asked:** should tags become labels in the UI, and if the word
"label" is already taken by share links, what should each thing be called? **Method:** every
occurrence of `label`/`labels`/`labelled` and `tag`/`tags` across `src/`, `mcp/`, the help
articles and the docs, grouped by what the word refers to.

## What the word means today

| Meaning | Where | Count | User sees the word? |
|---|---|---|---|
| The sender's private name for a share link (`ShareLink.label`, `linkLabel`) | links UI and modal, activity feed, view and brief emails, metrics per link, admin search, REST DTOs, four MCP tools and their descriptions, help articles, FEATURES/MCP docs | about 570 in code, 200 in docs | Yes: the modal's field heading "Label", "Labels are private to you", "Give the link a label", help "Label: a private name for the link", every MCP tool description |
| Generic display text: `aria-label`, `<label>`, `label:` keys in option lists, chart labels, `planLabel`, `proPriceLabel`, `viewerLabel`, `statusLabel` | everywhere | about 650 | No, as a noun. These are HTML and code vocabulary, not a product concept |
| Prose "labelled" meaning "marked with" | help articles (projects, analytics, share links), MCP errors and docs | about 30 | Yes, three help sentences and two MCP error messages |
| Internal display-string helpers: `agent.label` (client badge), `pageLabel` (PDF section name), `workspaceLabel`, `projectLabel`, the `activity/labels.ts` module | code | about 120 | No |
| Tags | tags page, sidebar section, tag picker, three MCP tools, activity sentences | about 980 | Yes, always as "tag" or "tags". The word "label" appears once, in the Tag model's own comment |

Two facts that settle a lot:

- **The tag's own text field is already `name`** (`Tag.name`, "As typed: 'Series A'"). So do API keys (`name`), projects (`name`), workspaces (`name`). Documents have a `title`. Only the share link calls its human-given name a `label`.
- **The links table already avoids the word.** Its column header is "Link", the value is rendered bare, and the modal says "The default link keeps its name". The product half-thinks of it as a name already.

## Recommendation

**Rule:** a document has a title, because it is content. Everything a person names has a name.
"Label" is then free to mean the classification feature.

| Thing | Today | Proposed | Why |
|---|---|---|---|
| A share link's private name | "label" | **name** ("link name" where a bare "name" is ambiguous) | Required, chosen by a human, searched by; the modal already says "keeps its name". Not "title": the document's title is shared by every link, and two titles on one card confuses |
| A project link's private name | "label" | **name** | Same field, same rule |
| The default link | "Default link" | **Default link** (unchanged) | It is a name |
| Audience note | "audience" | **audience** (unchanged) | Distinct concept, well named |
| Tags | "tag", "tags" | **labels** | Workspace-private classification with a curated set, colours and merge: what Gmail, GitHub, Linear and Notion call labels. "Tag" reads as public and disposable. The ledger already agreed in principle |
| Tag verbs | "tag", "untag", "tagged X as Y" | **label**, **remove label**, "labelled X as Y" | Works as a verb; the feed sentence stays one line |
| Generic display strings | `label`, `aria-label`, `planLabel`, … | unchanged | Code and HTML vocabulary, never shown as a noun |
| "labelled with the name they gave" (help prose) | "labelled" | **"marked with"** / **"attributed to"** | Once labels are a feature, "labelled" in prose reads as that feature |

## What changes, and in what order

Order matters: rename links first, so "label" is free before tags take it. Nothing stored is renamed; every step is copy, parameter names and docs.

**1. Share links: label to name** (do this first)

- Copy: `ShareLinkModal.tsx` field heading, helper line, validation message; `LinksManager.tsx` card headings; `/a/data/links` search placeholder; email preview fixture. About 10 strings.
- Help: `share-links.md`, `projects.md`, `connect-your-agent.md`. Three sentences.
- Emails: unchanged in wording (they print the name, not the word), but `viewNotifications.ts` comments and `FEATURES.md` say "label"; update the docs.
- MCP: the MCP is not deployed, so rename the input `label` to `name` on `lnkdrp_create_share_link`, `lnkdrp_update_share_link`, `lnkdrp_create_project_link`, `lnkdrp_update_project_link`, and in `lnkdrp_find_share_link`'s description and the `deleted` output; rewrite the ~20 description sentences and the two duplicate-name warnings in `mcp/src/errors.ts`. Keep `linkLabel` in the untrusted-wrapping key list and add `linkName` beside it. Update `docs/MCP.md`, `mcp/README.md`, the `/mcp/<client>` guides.
- REST: accept `name` and keep `label` as an alias on write; return both keys for one release, then drop `label` from responses. Activity meta keeps `linkLabel` (stored history). Model field `ShareLink.label` stays, with a comment saying it is the link's name; a field rename is a migration for no user-visible gain.
- Tests: `tests/lib/mcpReadmeContract`, `mcpDocsContract` and the e2e harness reference the parameter; they change with it.

**2. Tags: tag to label** (after 1)

- Copy: `TagsManager.tsx`, `SidebarTagsSection.tsx`, `TagPickerModal.tsx`, `DocActionsMenu.tsx`, the tags page header, the activity filter tab and the two feed sentences, `GetStartedActions` copy. About 42 strings.
- Routes: `/tags` and `/tag/[slug]` become `/labels` and `/label/[slug]` with redirects from the old paths; the sidebar links follow.
- MCP: rename `lnkdrp_tag`, `lnkdrp_untag`, `lnkdrp_list_tags` to `lnkdrp_add_labels`, `lnkdrp_remove_labels`, `lnkdrp_list_labels`; input key `tags` to `labels`; outputs `createdTags`, `notTagged`, `taggedItems` to `createdLabels`, `notLabelled`, `labelledItems`; `lnkdrp_list_docs` filter `tag` to `label` and its `tagMatched` echo to `labelMatched`. Update the discovery tool's capability text and `docs/MCP.md`.
- REST: `/api/tags` and `/api/tags/assignments` stay as paths (internal callers only) or gain `/api/labels` aliases; not user-facing.
- Internal identifiers stay: `Tag` model, `tag.applied`/`tag.removed` activity types (stored rows), `tagSlug`, `src/lib/tags`. Renaming those is a migration with no user-visible gain.
- Help: add the missing labels article while touching this; today there is none for tags.

**3. Prose**

- Replace "labelled" in `projects.md`, `analytics.md`, `share-links.md` and the two MCP error messages with "marked with" or "attributed to".
- Rename `agent.label` to `agent.client`-style wording in docs where it appears as a noun ("client label"); code can keep the field.

## Effort and risk

- Step 1 is a few hours of copy and parameter work plus test updates. The only external contract is the MCP, which has no production users yet; doing it before the MCP deploys costs nothing, doing it after costs every connected agent a reconfiguration.
- Step 2 is about the same size, plus two route redirects.
- Step 3 is fifteen minutes.
- No database migration in any step. Stored activity rows keep `linkLabel` and `tagName`; the sentence builders render whatever the current noun is.

## If we do nothing

Keep "Tags" as the UI noun and "Label" for links. It is internally consistent today and the only cost is the weaker word for the classification feature. What should not happen is renaming tags to labels without step 1: "the Sequoia link" and "the Series A label" would sit in one activity row, and the MCP would carry a `label` parameter on links beside a labels tool for classification.
