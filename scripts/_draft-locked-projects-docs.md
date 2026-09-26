# Draft — locked-projects documentation (for the orchestrator to merge)

Written 2026-09-26 by a read-only agent against the working tree while another agent was building
M3. **Nothing here has been merged into `docs/`.** Three blocks below, each ready to paste:

1. `## FEATURES.md — "Locked projects", for the Projects section`
2. `## CHANGELOG — a section for docs/CHANGELOG-2026-09-26.md`
3. `## SECURITY.md — where it fits, and the sentences`

A fourth block, `## What is NOT covered yet`, is the honesty list: read it before merging, because
some of the shipped copy promises things the code does not do yet.

**Verification basis.** `git status --short`, `git diff` and the files themselves, on 2026-09-26.
M1 and M2 are on disk and uncommitted (`git log --oneline -8` shows no locked-projects commit; the
newest is `a3d98c3 The admin gate and the data room read the cookie jar too`). M3 was being edited
while I read, so every M3 claim below is marked **unverified** rather than stated.

---

## FEATURES.md — "Locked projects", for the Projects section

Place it in `## Projects`, immediately after the **A document's home, and staying inside it** entry:
the lock is the other half of that work and the entry's last sentence ("This is the containment that
private projects will build on") is the hand-off.

- **Locked projects — a private data room** (`docs/prds/lnkdrp-locked-projects.md`, built
  2026-09-26):
  - **What a lock is.** `Project.visibility: "workspace" | "locked"` (default `"workspace"`, with
    `lockedAt` and `lockedByUserId` recording the moment and the person). `"locked"` is a private
    data room: it exists for the people holding a `ProjectMembership` row and for nobody else. The
    word mirrors `Doc.visibility` so the two settings read as one vocabulary — containment says which
    listings a document appears in, the lock says which people a project exists for. A row written
    before the field existed has no `visibility` at all and is open, which is why every filter spreads
    `{ visibility: { $ne: "locked" } }` through `projectVisibilityClause()` in
    `src/lib/projects/lockScope.ts` and never an equality.
  - **What a non-member experiences: absent, not restricted.** No row in `/api/projects`, the left
    sidebar, the projects modal or any picker; no name in a feed row, an email or a Slack post; and
    404 by id and by slug, with a body byte-identical to a project id that never existed. Slugs are
    `slugify(name)` and unique per workspace, so they are guessable by construction and a 403 on a
    read would be a sentence reading "a private room with this name exists". The by-id/by-slug read
    is one helper, `resolveProjectForActor` in `src/lib/projects/resolveProject.ts`, so a room that
    does not exist, one in the trash, one in another workspace and one you are not in are all the
    same answer. 403 keeps the meaning it has today: you can see this room and you lack the
    workspace role for this write. A room's name is a leak on its own, so `projectNamesFor` in
    `src/lib/projects/names.ts` is the one place an id becomes a name and answers `null` for a room
    the reader may not see, which callers render as "a private data room".
  - **No bypass for owners or admins.** Decided 2026-09-26. The visibility clause has no role term.
    A workspace owner or admin who is not in a locked room does not see it in the project list, in
    the sidebar, by id, by slug, in the project count, in Slack or in their inbox — they see exactly
    what a person outside the workspace sees, which is nothing. `requireOrgRole` stays orthogonal:
    the filter decides whether the row comes back, the role decides what may be done to it. The only
    way into a room is being added, which writes a feed row the room's members can read. The promise
    is worded "nobody else in your workspace", never "nobody else": platform admin keeps its
    cross-workspace read for support.
  - **The lock icon.** One component, `src/components/project/ProjectLockIcon.tsx`, drawn wherever a
    room is named — the sidebar row, the sidebar projects modal, the project header, a document
    page's project pills, and the Slack routing card — so the people who are in a room can see at a
    glance that others are not. A `<select>` cannot hold an icon, so `lockedOptionLabel()` renders
    "Acme Raise (private)" in the pickers instead. The word in the UI is **private**; the padlock is
    the icon for it.
  - **Membership.** `ProjectMembership` is its own collection
    (`{ orgId, projectId, userId, role: "editor" | "reader", via: "creator" | "added" |
    "break_glass", addedByUserId, reason, isDeleted, revokedAt }`, unique on `{ projectId, userId }`).
    `GET/POST/DELETE /api/projects/:idOrSlug/members` is the one part of the feature that refuses
    rather than filters, because a caller who got this far has already demonstrated the room exists.
    All three methods refuse an `lnk_` API key through `forbidApiKey` — membership is identity, and
    identity is not delegated to a key — and the two writes need the `member` workspace role. Any
    member who can see the room can read the roster, viewers included. A room holds at most 200
    people (409 `PROJECT_MEMBER_CAP`); removing the last member of a locked room is refused (409
    `LAST_PROJECT_MEMBER`, "Unlock it or add someone first"); adding somebody who is not in the
    workspace is a 400, not a 404, because nothing about the room is disclosed by it; and removing
    somebody who is already out is a no-op `{ removed: false }`. `GET /api/projects/:id` returns
    `visibility`, `members[]`, `visibleBecause: "workspace" | "member" | "break_glass"` and
    `membersCanManageLinks`, so the roster and its banners render a field rather than infer one.
    Grants are soft-deleted with `revokedAt` through the one writer allowed to clear them,
    `revokeProjectGrants`, which the workspace-membership revoke route, `/api/orgs/:id/leave`, the
    workspace-delete sweep and `src/lib/accounts/purge.ts` all use: a removed person who is
    re-invited comes back into the workspace with no rooms. `project.member_added` and
    `project.member_removed` carry `projectId` and so live in the room's own feed; `project.locked`
    and `project.unlocked` are recorded with `projectId: null` and stay in the workspace feed, because
    a room that vanishes from ten sidebars with no explanation is a support ticket.
  - **Creating and locking.** `POST /api/projects { locked: true }` creates a private room and seats
    its creator (`via: "creator"`); the left sidebar's **New project** dialog carries a "Make it
    private" checkbox, hidden entirely in a personal workspace, where there is nobody to hide from.
    Locking an existing room is a review and not a confirm: `GET /api/projects/:id/lock-review`
    computes, before the write, how many workspace members lose sight of the room (by name), how many
    documents leave workspace listings and how many of those stay visible in another room, how many
    share links are live and the room's `/p/:shareId` URL, whether Slack posts will stop, and how many
    pending notification rows will be dropped. It also preselects who keeps access from what has
    already happened in the room — its creator, everybody who uploaded one of its documents, and
    everybody with a `project.*` activity row for it, with the person doing the locking always in.
    Unchecking a name is the act of removing access. `PATCH /api/projects/:id { visibility }` refuses
    without the review's signed token whenever there is anything to review (400
    `LOCK_REVIEW_REQUIRED`; the token is HMAC'd, bound to one room, one person and one direction, and
    lasts ten minutes). Unlock is the mirror and **keeps** the grants, so re-locking restores the same
    room and an accidental unlock is not a data loss. A request inbox can never be locked: 400
    `LOCK_NOT_SUPPORTED_ON_REQUEST`, because people outside the workspace upload into it through its
    link.
  - **What stays open for recipients.** Nothing changes for them, and it is pinned by
    `tests/lib/lockedProjectRecipients.test.ts`, which asserts the recipient half of the product does
    not import `lockScope` at all: `/p/:shareId` and its document pages, PDF and preview routes,
    `/api/share/:shareId/**` including stats and unlock, download claims, request inboxes and
    replace links. The refusal set (`archived`, `disabled`, `expired`, `project_gone`) gains no fifth
    value. Recipient-side writes stay whole — a visit still records its share view, its project-link
    view, its page timings and its activity rows — and only the workspace-side audience for the
    resulting emails, rows and posts narrows.
  - **Links already sent keep working.** Locking is not unsharing. It does not touch `shareEnabled`,
    does not archive links and does not rotate `Project.shareId`, because rotating it would break
    rooms already sent to recipients. So a room can be invisible to colleagues and open to the world
    at the same time, and the lock dialog says so with the fix one click away: it shows the live
    `/p/:shareId` URL under "This data room is still shared publicly. Locking changes who in
    <workspace> can see it, not who outside can", with an inline "Turn off the public link too"
    checkbox. The members panel repeats it where it bites again: removing somebody does not change
    the room's share links, and any workspace member who saw the slug before the lock keeps recipient
    access afterwards, as does anyone they forwarded it to.
  - **Elsewhere.** Slack routes a locked room to its own mapped channel or nowhere, never to the
    catch-all (`routingFor` in `src/lib/slack/outbox.ts`), which is the same shape a contained
    document already takes; a locked room with no mapped channel goes silent, which the lock dialog
    names. The realtime projects watcher reads `visibility` and skips a locked room's frame
    altogether, because that frame broadcast a project's name to every socket in the workspace. The
    plan's project cap deliberately keeps counting locked rooms (`allProjectsFilter` in
    `src/lib/projects/scope.ts`, split out of `liveProjectFilter` for exactly this), so a workspace
    cannot make Free unlimited by locking; the consequence is that "at your limit" tells a non-member
    rooms exist they cannot see, which is accepted. Deleting a room deletes its grants and resets
    `Doc.visibility` back to `"workspace"` for any document that loses its home, so a contained
    document is no longer stranded invisible by a hard delete. Existing data is untouched:
    `db/migration/20260925_0007_projects_locked_indexes.mjs` creates four indexes and writes no
    documents, and there is no backfill seating current members as grantees.

---

## CHANGELOG — a section for `docs/CHANGELOG-2026-09-26.md`

If a `docs/CHANGELOG-2026-09-26.md` already exists, paste the `## Locked projects` section into it.
If it does not, the file opens the way the 25 September one does:

```
# Changes — 26 September 2026

On the `next-release` branch; nothing here is on `main` yet. Grouped by what it affects.

---
```

Then:

```
## Locked projects — a private data room (new)

Decided and built from `docs/prds/lnkdrp-locked-projects.md`, whose 32 decisions came out of a map
of 117 access surfaces. It is the other half of the containment work from 25 September: that
shipped a document listed only inside its room, and stopped short of membership.

**A lock, and who it is for.** A project can be created private or made private later
(`Project.visibility: "workspace" | "locked"`, with `lockedAt` and `lockedByUserId`). A private
room exists for the people holding a `ProjectMembership` row. For everyone else in the workspace
it is not restricted, it is absent: no row in the project list or the sidebar, no name in a picker,
a feed row, an email or a Slack post, and 404 by id and by slug with a body byte-identical to an id
that never existed. Slugs are guessable by construction, so a 403 on a read would itself be the
leak. A padlock sits beside the room's name wherever it appears, and the pickers say "(private)"
because a `<select>` cannot hold an icon.

**No bypass for workspace owners or admins.** The visibility clause has no role term. An owner or
admin who is not in the room sees exactly what a person outside the workspace sees, which is
nothing. The rooms people lock are the ones whose excluded reader is senior — the acquirer list
before the founder is told, a comp review, counsel's file — and a lock an owner can read is a
listing filter with a padlock on it. The role system is untouched and stays orthogonal: the filter
decides whether the row comes back, the role decides what may be done to it. The only way in is
being added, which writes a feed row.

**Locking is a review, not a confirm.** Before the write, the dialog says how many colleagues lose
sight of the room by name, how many documents leave workspace listings and how many stay visible in
another room, how many share links are live, whether Slack goes quiet, and how many pending emails
are dropped. It preselects who keeps access from what has already happened in the room — its
creator, its documents' uploaders, anyone with a `project.*` row for it — because counting who
loses access while making the locker assemble the keeper list from nothing is how a lock breaks a
week. Unchecking a name is how access is removed. The confirm carries a ten-minute signed token
bound to that room, person and direction, so nobody reaches this state without having seen it.
Unlocking keeps the grants, so re-locking restores the same room.

**Locking is not unsharing, and the dialog says so.** A lock does not touch the room's public link,
does not archive its links and does not rotate its share id, because rotating it would break rooms
already sent to recipients. So the dialog shows the live `/p/:shareId` URL — "Locking changes who
in your workspace can see it, not who outside can" — with an inline "Turn off the public link too"
checkbox. Anyone who had the slug before the lock keeps it, and so does anyone they forwarded it
to. Removing somebody from the room does not change its links either, and the members panel says
so beside the button.

**Nothing changes for recipients**, pinned by a test that asserts the whole recipient half of the
product never imports the lock helper: the room's public pages, its documents, PDFs and previews,
the share APIs, download claims, request inboxes and replace links. Only the workspace-side
audience for the resulting emails, rows and posts narrows.

**Members.** A room holds up to 200 people; its roster is readable by anyone who can see the room,
viewers included. Removing the last member of a private room is refused. An API key cannot read or
change a member list at all — membership is identity, and keys do document work. Grants are cleared
through one function wherever somebody leaves the workspace, is revoked, or is purged, and they keep
a `revokedAt` so "who has ever been in this room" stays answerable; a removed person who is
re-invited comes back with no rooms.

**Two things the lock deliberately does not do.** The plan's project cap keeps counting private
rooms, so a workspace cannot make Free unlimited by locking; "at your limit" therefore tells a
non-member that rooms exist they cannot see, which is accepted. And a request inbox can never be
locked, because people outside the workspace upload into it through its link.

**Fixes that rode along.** The realtime projects watcher broadcast every project's name to every
socket in the workspace and now reads the room's visibility first. A dozen queries that existed
only to turn a project id into a name became one helper, which tenanted the three that had no
workspace clause at all (the activity feed, notification emails and visit briefs). And deleting a
project used to strand a contained document — invisible in every workspace list and in every
project, while its public link kept serving it; the delete now puts those documents back in the
workspace and removes the room's grants.
```

---

## SECURITY.md — where it fits, and the sentences

**Yes, there is a fitting section.** Two, and the lock belongs in both. Do **not** add a new
top-level section for it.

**§3 "The gates", in the "Which row may this actor touch" table.** It already lists
`liveProjectByIdMatch` and `liveProjectFilter`, which are the two functions this feature changed, so
the table rows want amending rather than a new home. Suggested replacement rows:

```
| `liveProjectByIdMatch` `projects/scope.ts` | The same, for one project by id or (`liveProjectBySlugMatch`) by slug. Takes a required `viewerUserId`. |
| `liveProjectFilter` `projects/scope.ts` | Which projects may this person see? `allProjectsFilter` is the lock-free half, and the plan cap is its only other caller. |
| `projectVisibilityClause` / `lockedHomeExclusion` `projects/lockScope.ts` | Is this a private data room, and is this document's home one? Spread into the filter, never restated. |
```

And the sentences to add after that table's existing paragraph:

> A locked project (`Project.visibility: "locked"`) is absent rather than refused: the clause has no
> role term, so an owner or admin outside the room gets the same 404 as a stranger, and there is no
> lock-free by-id project read outside `src/app/api/admin/data/projects/**`. `projectGrantIds` fails
> **open** because its ids only ever widen what a caller sees; `hiddenProjectIds` fails **closed**,
> refusing the listing past its 5000 cap, because a `$nin` against a truncated array matches
> everything — the asymmetry is deliberate and is the one thing not to "fix" here.

**§9 "Known open", for what a lock does not protect against.** Add one bullet:

> - **A lock changes who in the workspace can see a room, not who outside it can.** Locking does not
>   touch `shareEnabled`, archive links or rotate `Project.shareId`, so every `/p/:shareId` URL
>   already sent stays valid and anyone it was forwarded to keeps recipient access; the lock dialog
>   shows the live URL with a "turn off the public link too" checkbox rather than doing it silently.
>   Two smaller residuals are accepted and mitigated by copy, not by hiding: the plan's project cap
>   counts private rooms, so "at your limit" tells a non-member rooms exist, and a Slack channel's
>   audience is Slack members rather than `OrgMembership` rows, so a private room mapped to a public
>   channel is readable by whoever is in that channel.

**One naming collision to watch when merging.** §4 "The public surface" already uses "a locked room"
to mean a **password-protected project link** ("a locked room must answer every candidate document id
identically"). That sentence predates this feature and is about a different lock. If the merged
document uses "locked" for visibility, §4's line wants rewording to "a password-protected room" so
the two do not read as one rule.

---

## What is NOT covered yet

Milestones 3 to 8 in the PRD. Some of the shipped copy already promises a few of them, which is the
part to decide before release.

**M3 — documents and every by-id surface. UNVERIFIED: in flight while I read.** `lockedHomeExclusion`
is already threaded into `buildDocMatch` and imported by roughly forty files under `src/` (the
document routes, uploads, tags, starred, changes, contacts, dashboard stats, workspace analytics,
share-link search), but another agent was editing exactly those files during this read, so **no M3
claim belongs in the merged docs until it is re-checked against the tree.** Until M3 is complete, a
locked room is a listing filter rather than access control: the document page, the PDF bytes, the
extracted text and the per-audience link slugs are one guessed id away.

**M4 — feed, metrics events and realtime. NOT built.**
- `GET /api/activity?projectId=<locked room id>` still returns that room's rows to a non-member.
  The route filters what a returned row can *say* — document titles and `shareId`s go through
  `lockedHomeExclusionFor`, project names through `projectNamesFor` — but not which rows come back.
  The route's own comment says so ("Which feed ROWS a non-member sees is M4's job").
- `/api/activity/summary` has no exclusion on either aggregate, so a locked room's uploads inflate
  every member's header counts.
- Realtime per-socket filtering is not built: no grant set on the ticket, no `Client` grant set, no
  `projectId` on the activity/documents/uploads frames, no `projectmemberships` change stream. Only
  the projects-watcher name leak is fixed.

**M5 — notifications. Partly built.**
- `src/lib/projects/audience.ts` / `notifiableMemberIds` **does not exist**. The four fanout sites
  (share stats, the three blocks in the upload processor, visit briefs) still enqueue one row per
  workspace member, so a view on a locked room's document emails everybody.
- There is no send-time "not a project member" skip reason in `runGroup`.
- `skipPendingForProject` **is** built and the lock write calls it, so pending rows owed to
  non-members at the moment of the lock are dropped — which is what the dialog's number counts. Mail
  enqueued *after* the lock still goes out to the whole workspace.
- The version-recipients roster (`docs/[docId]/history/[version]/recipients`) and `visitBriefs.ts`'s
  fallback actor: not verified as changed; they appear untouched.
- Slack's mitigations beyond routing are **not** built: no `conversations.info` `is_private` /
  `num_members` hard-warn anywhere in `src/`, and the channel picker is not empty-by-default.
  `lnkdrp_whoami`'s `channels[].projectIds` filter: not verified.

**M6 — break-glass. NOT built, and copy already promises it.** There is no
`POST /api/projects/:id/break-glass` route and no `liveProjectByIdMatchUnlocked` export. The
`via: "break_glass"` enum value, the `reason` field and `visibleBecause: "break_glass"` all exist and
are inert. **`src/components/project/ProjectMembersPanel.tsx` already renders the permanent line
"Workspace owners: none unless added. An owner can add themselves in an emergency, and everyone here
is told."** — which describes a route that does not exist. Either M6 lands before the option reaches
users, or that half-sentence comes out. Worth flagging to the owner: M2's workspace-level revoke can
already produce a locked room with nobody in it, and break-glass is the only way back into one.

**M7 — surfaces. Mostly built, with gaps.** Built: the create dialog's private checkbox (suppressed
in a personal workspace), the lock review with its counts, history-preselected keepers and inline
public-link checkbox, the unlock review, the padlock, the roster with its owners line and its
"nobody in this room can manage its share links" line, and the members panel's suppression in a
personal workspace. Not built: the plan-limit copy from decision 29 — `planLimits.ts` reads
`allProjectsFilter` but carries no "some data rooms here are private" sentence, so the refusal still
names a count a non-member cannot reconcile. `src/components/modals/DocProjectsModal.tsx` declares
`visibility` on its row type but renders no padlock, so a document's project list is the one place a
private room is named without one.

**M8 — MCP and the oracle test. NOT built.** `lnkdrp_create_project` has no `locked` option.
`tests/lib/lockedProjectOracle.test.ts` does not exist, so nothing pins latency parity or the
enumeration list. `docs/MCP.md` is untouched. The MCP tools do inherit the route filters (the server
holds no database access and proxies REST with the caller's key), and `forbidApiKey` on the members
and lock routes is built, so a key is already refused there — but the error-copy audit asked for in
decision 28 has not happened.

**Open questions still open.** Creating "Acme Raise" against a locked `acme-raise` still returns
`acme-raise-2` in a 200, which enumerates the locked slug namespace (open question 3, unfixed).
`Project.containNewDocs` (open question 2) does not exist, so a document uploaded into a locked room
after the lock is `visibility: "workspace"` and depends entirely on M3's home exclusion to stay out
of workspace search. The owner-only `GET /api/orgs/:orgId/locked-rooms` compliance read (open
question 4) is not built.

**Tests on disk** (all uncommitted, none run by me — running the suite would have raced the other
agent): `tests/lib/lockedProjectScope.test.ts`, `lockedProjectSurfaces.test.ts`,
`lockedProjectLifecycle.test.ts`, `lockedProjectCreate.test.ts`, `lockedProjectMembers.test.ts`,
`lockedProjectRecipients.test.ts`. The PRD's `lockedProjectOracle.test.ts` is absent. **Whether they
pass is unverified.**
