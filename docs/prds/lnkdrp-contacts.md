# PRD — Contacts

**Status:** Built 2026-09-25 (M1-M4). CSV export added at the owner's request. Deferred, not
missing: the links from reader pages, brief emails and Slack posts to a contact (decision 8); the
list filters by document, project and source link (decision 5), where the API takes `docId`,
`projectId` and `shareId` but no control or link in the product produces one yet; and the contacts
count beside the sidebar entry (decision 5), where the entry is there and the count is not.
**Owner:** chrissanz
**Last updated:** 2026-09-25
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-tags](./lnkdrp-tags.md) · [lnkdrp-visit-briefs](./lnkdrp-visit-briefs.md) · [lnkdrp-view-notifications](./lnkdrp-view-notifications.md) · [lnkdrp-project-links](./lnkdrp-project-links.md)

---

## Problem

lnkdrp knows a great deal about the people who read what a workspace shares, and has nowhere to
put them. Priya Nair introduces herself on the pitch deck, opens the data room twice, finishes
the cap table, requests a download of the contracts summary. Each of those is a row somewhere:

- `ShareView` / `ProjectLinkView`: one per link per browser, with `viewerName`, `viewerEmail`,
  `viewerUserId` when they signed in.
- `ShareVisit`: the sessions, keyed by browser (`botIdHash`), the material of the visit briefs.
- `ShareViewerEmail`: `(orgId, email)`, whether the address was confirmed.
- `ShareDownloadRequest`: the address someone typed to ask for a file.
- `Upload` via a request inbox: who dropped a file in.
- Activity rows: `viewer.introduced`, `share.viewed`, `project.landed`, `share.visit_briefed`.

There is a page per reader per document or project (`/doc/:id/metrics/viewer/:key`), which is the
right shape for "what did she read here", and nothing for "who is Priya, what has she touched
across everything, and what do I want to remember about her". A founder running a raise across
four decks and two data rooms has no list of the forty people in it. Tags exist for documents and
projects (`TAG_TARGET_KINDS = ["doc", "project"]`); a person cannot be tagged.

There is no concept of a contact. This document proposes one.

## Goal

A **contact** is a person a workspace has heard from, kept once per workspace, gathered
automatically, and owned by the workspace: name, address, where they came from, what they have
touched, when, and what the team has noted or tagged about them. A **Contacts** entry in the left
sidebar lists them, sorts and filters them, and each opens a page that is the reader page's
cross-document twin.

Nobody types a contact in. Every introduction, signed-in view, download request and request-inbox
upload creates or updates one. The team adds the two things the system cannot know: tags and a
note.

## Non-goals (v1)

- A CRM. No deals, no stages, no reminders, no email sending, no sync to HubSpot or Attio (Future:
  export CSV; a webhook per new contact).
- Merging two contacts by hand, or splitting one. Identity is the address; a person with two
  addresses is two contacts until they sign in with one and introduce the other (Future).
- Contacts for anonymous readers. A browser that never gave a name or address is a visit, not a
  person, and stays where it is.
- Cross-workspace contacts. Telling one workspace who you are tells only that workspace, as
  `ShareViewerEmail` already promises.
- Editing a contact's name or address. They said who they are; we record it. A note is where the
  team's own words go.

## Proposed decisions (to lock)

1. **Identity is the address, per workspace.** `Contact` is keyed `(orgId, email)`, lowercased,
   the same key `ShareViewerEmail` uses. That table is not replaced: it is the confirmation
   flow's own record and it works; a contact reads `verifiedAt` from it by the shared key, and
   nothing in the confirmation path learns that contacts exist. A signed-in reader's account
   email is their address. A reader who gives only a name is not a contact until they give an
   address; the name is kept on the view as now.

2. **Contacts are gathered at the four moments the product already records a person.** No new
   capture UI. Each site upserts the contact and appends to its history:
   - introduce yourself (`share/[shareId]/landing` and the project twin) → `firstSeenAt`,
     `name`, source link;
   - a signed-in view (`viewerUserId` present) → the account's name and email;
   - a download request (`ShareDownloadRequest.email`);
   - a request-inbox upload that carries an address.
   Visits and briefs do not create contacts; they attach to one that exists through the address
   on the view. The upsert is idempotent and off the hot path (`after()`), like the Slack outbox.

3. **What a contact carries.** `name` (the latest they gave, with the first kept), `email`,
   `domain` (the address's domain, or null for the webmail providers, so `gmail.com` never
   becomes a company; a display name for it is Future), `firstSeenAt`, `lastSeenAt`, `verifiedAt`,
   `sources` (the links and inboxes they arrived through, with counts), `docIds` / `projectIds`
   touched (denormalised, capped), `visits` and `documentsRead` counters, `note` (one free-text
   field, team-written, 2,000 chars), and tags through `TagAssignment` with a third target kind,
   `contact`. Nothing here is not already stored somewhere; the table is a view that stays warm.

4. **Identity follows the plan, exactly as everywhere else.** Free sees, in full, the contacts
   who introduced themselves, because introductions are already shown on Free; every other
   contact (signed-in views, download requests) is a row with a domain and a date and no name or
   address, plus the total, which is the same amount Free's analytics record and the same upsell
   the reader page makes. Pro sees everything. No blurring: a row either shows a field or omits
   it.

5. **A Contacts entry in the sidebar, under Activity.** `/contacts`: a table, not cards. Columns
   name, domain, tags, last seen, documents read, visits; sort by any; filter by tag, by
   document or project ("everyone who has read the pitch deck"), by source link ("everyone who
   came in through the Sequoia link"), and search by name, address or domain. The count is in the
   sidebar the way documents and projects are. `/contacts/:id` is the contact page: identity,
   note, tags, and the history: every document and project they touched, each row linking to
   the existing reader page, which is not rebuilt.

6. **Every member reads; members and above write.** Viewers see the list and the pages and can
   change nothing. Members, admins and owners tag contacts and write the note. The note keeps who
   last edited it and when, because "warm, per Chris, Tuesday" is what the next reader needs.

7. **Tags are the tags.** `TAG_TARGET_KINDS` gains `"contact"`. The tag page (`/tag/:slug`) grows
   a third section. Assigning is the same picker as on a document. A tag on a contact is how
   "investor", "passed", "warm", "counsel" get said; the product does not invent a status field.

8. **Contacts appear where the person already does.** The reader page, the visit brief email,
   the Slack post and the activity row link to the contact when there is one, by name. That is
   the whole discovery: the first time a founder sees "Priya Nair" underlined in a brief and
   lands on her page with the four documents she has read, they understand the feature.

9. **Privacy and deletion.** A contact is someone else's personal data held by the workspace.
   Account purge and workspace deletion remove the workspace's contacts with everything else
   (`purgeCompleteness` enforces the purge side). A recipient's own request to be forgotten is served the way it is today, by
   support, and now has one row to remove per workspace instead of a scatter. The privacy help
   article and the policy name contacts explicitly. Contacts never leave the workspace: no
   export in v1, no agent tool that writes them.

10. **Agents read contacts, and only read.** `lnkdrp_list_contacts` (search, tag, document,
   since) and `lnkdrp_get_contact`, Pro-gated like the rest of identity; results wrap names and
   notes as untrusted text like every other reader-supplied string. No write tool: a note is a
   person's judgement.

11. **Backfill once.** A migration walks `ShareView`, `ProjectLinkView`, `ShareDownloadRequest`
    and `ShareViewerEmail` per workspace and builds the table, so the page is full on day one
    rather than starting from the next visitor.

## Open questions

1. **Company.** Domain → company name is right for `sequoiacap.com` and wrong for `gmail.com`.
   A webmail list handles the second; the first still needs a display name. v1 shows the domain;
   a small editable `company` field is the likely v2.
2. **Two addresses, one person.** A reader introduces themselves as `priya@sequoiacap.com` on
   one link and signs in with `priya.nair@gmail.com` on another. Two contacts in v1. Is that
   acceptable for a raise, where this happens with every investor who reads on their phone?
3. **Free.** Decision 4 shows Free a blurred list. Is the count alone enough of a reason to
   upgrade, or should Free see its introduced contacts in full and nothing else?
4. **Sidebar weight.** Contacts as a top-level entry beside Activity and Agents, or inside
   Metrics? Top-level is proposed because the ask is "sort them, tag them", which is a list of
   its own.

## Verification

1. Introduce yourself on a link from a fresh browser: a contact appears in the list within a
   second, named, with the link as its source and the document in its history. The page refetches
   on the realtime frames the capture already sends; the sidebar entry carries no count yet.
2. Open a second document on another link with the same address: one contact, two documents,
   `lastSeenAt` moved, no duplicate.
3. Request a download with a new address: a contact with no name, the request as its source.
4. On Free, the list shows the introduced contact in full and the download-request contact as a
   domain and a date; on Pro, both in full.
5. Tag a contact "investor" from its page; the tag page lists it under a Contacts section; the
   list filters by it.
6. Delete the workspace: its contacts are gone; a second workspace that heard from the same
   address keeps its own.
7. `lnkdrp_list_contacts` from Claude Code returns the two rows on Pro and refuses identity on
   Free; the note comes back wrapped as untrusted text.

## Milestones

- **M1 — The table and the backfill.** `Contact` model, the four upserts, the migration,
  `purgeCompleteness`. Nothing visible; verified by counts against the views.
- **M2 — The page.** Sidebar entry, `/contacts` with sort, filter and search, `/contacts/:id`
  with history and note. Plan gating per decision 4.
- **M3 — Tags and links.** `contact` as a tag target, the picker, the tag page section; the
  reader page, brief email, Slack post and activity rows link to the contact.
- **M4 — Agents.** The two read tools, docs/MCP.md, the help article.

## What exists already, and is worth not rebuilding

- `src/lib/models/ShareViewerEmail.ts`: the `(orgId, email)` key and the confirmation flow.
  Contact is this table with more columns.
- `src/components/metrics/ViewerProfile.tsx` and the reader page: the per-document history,
  which the contact page links to rather than copies.
- `src/lib/tags/service.ts` and `TagAssignment`: a third `targetKind` is a small change.
- `src/lib/slack/messages.ts` `readerName` / `readerPage` and the brief email's reader line: the
  places a name becomes a link.
- `viewer.introduced`, `share.viewed`, `project.landed` activity rows: the sources.
