# PRD — Locked projects (a private data room, with a lock on it)

**Status:** Draft 2026-09-26, decisions 1-32 proposed, not built. Designed from a map of 117 access surfaces (projects 39, documents 29, lifecycle 19, MCP 17, notifications 13) and three competing access models judged by an attacker lens, an operator lens and a product lens. Two of the three judges chose the strict model: no bypass for owners or admins, with an owner-only break-glass that grants membership and says so in the feed. The holes the judges found in every design (the contacts surface, the slug-suffix oracle, the equivalence of a share id to the document, the non-transactional delete) are folded in as decisions 13, 15 and 32 and open question 3.
**Owner:** chrissanz
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-project-home](./lnkdrp-project-home.md) - [lnkdrp-project-links](./lnkdrp-project-links.md) - [lnkdrp-slack](./lnkdrp-slack.md) - [lnkdrp-enterprise](./lnkdrp-enterprise.md) - [FEATURES](../FEATURES.md)

---

## Problem

A workspace is one room. Every member sees every project, every document, every reader's name and
every notification. That is right for a small team sharing one pipeline and wrong the moment a
workspace holds a fundraise, an acquisition, a performance file or a board pack. The people who
need to keep those apart do it today by opening a second workspace, which splits their billing,
their agent keys, their Slack connection and their analytics, and which nobody does twice.

Slack solved this with a private channel and taught a generation of people what the lock means:
this room exists for the people in it. The containment work shipped on 2026-09-25 built the
precondition, a document that is listed only inside its project, and deliberately stopped short of
membership. This is the other half.

## Goal

A person creates a project with a lock on it, or locks one they already have, and adds the
workspace members who are allowed in. For everyone else in the workspace the room is not
restricted, it is absent: no row in the sidebar, no name in a picker, no documents in any list, no
rows in the feed, no realtime frames, no view emails, no visit briefs, no Slack posts to a channel
they can read, and nothing an agent acting for them can reach. A locked room carries a lock icon
wherever it is named, exactly as Slack does, so the people who are in it can see at a glance that
others are not.

Nothing changes for recipients. A data room's public link is the product, and it keeps working
for the people it was sent to whether the room is locked or not.

## Non-goals (v1)

- Per-document permissions inside a room. The room is the unit.
- Guest accounts, external members, or anything that puts a non-member of the workspace on a
  member list.
- Rotating a share id when a room is locked. A link already sent stays valid, which decision 26
  makes explicit in the locking dialog rather than quietly.
- A second workspace-wide role. The lock composes with the roles that exist; decision 24 says what
  happens when a room has no member holding the role its own links require.

# Proposed decisions (to lock)

1. **A project's lock is a word on the project row, not a second collection lookup.** New field
   `Project.visibility: "workspace" | "locked"`, default `"workspace"`, indexed, beside
   `isRequest` and `isDeleted` in `src/lib/models/Project.ts`, with `lockedAt: Date | null` and
   `lockedByUserId` recording the moment and the person. The word mirrors
   `Doc.visibility: "workspace" | "project"` from the project-home PRD, so the two settings read as
   one vocabulary: containment says which listings a document appears in, the lock says which people
   a project exists for. Every filter spreads `{ visibility: { $ne: "locked" } }`, which is a `$ne`
   on purpose: every project row in the database today has no `visibility` field at all, and
   `db/migration/20260925_0003_projects_live_unique_names.mjs` exists because
   `isDeleted: false` is an equality that rows without the field escaped. Nobody may
   "optimise" the clause into `visibility: "workspace"`, and the helper carries that sentence as a
   comment. Rejected: `isLocked: boolean`, which is cheaper to type and gives the schema two words
   for the same idea, and leaves no room for a third state (a read-only or an archived room) without
   a second field.

2. **`src/lib/models/Project.ts` gets the hot-reload schema patch `OrgMembership.ts` already has.**
   `if (Existing && !Existing.schema.path("visibility")) Existing.schema.add({ ... })`, the same
   three lines and the same comment as `docUploadEmailMode` and `viewEmailMode` carry today.
   Locking is a PATCH-shaped write and strict mode silently drops an unknown path on PATCH, so a
   hot-reloaded dev server would accept the lock request, write nothing, and present the bug as an
   authorization failure. `Project.ts` has no such patch today, which is why this is a decision and
   not an implementation note.

3. **Membership lives in its own collection, `ProjectMembership`, and grants carry their own
   revocation.** `src/lib/models/ProjectMembership.ts`:
   `{ orgId, projectId, userId, role: "editor" | "reader", via: "creator" | "added" | "break_glass",
   addedByUserId, reason, isDeleted, revokedAt }`, with a unique index on `{ projectId, userId }`,
   `{ orgId, userId, isDeleted }` for the question every request asks, and
   `{ orgId, projectId, isDeleted }` for the roster. Four reasons, all of them specific to this
   repo. The hot question is "which locked rooms may this person see", keyed on `userId` across
   projects, which wants its own index either way. `src/app/api/orgs/[orgId]/members/[userId]/revoke/route.ts`
   soft-deletes an `OrgMembership` and `src/app/api/org-invites/claim/route.ts` deliberately revives
   a revoked row with the invite's role, so a grant needs a `revokedAt` of its own that claim never
   touches, or a removed person's room access comes back with them. `src/lib/accounts/purge.ts`
   needs to delete grants both by `orgId` and by the `projectIds` it pre-reads. And a roster on the
   project row would eventually be `select`ed into a project DTO by accident, where a separate
   collection cannot leak through a projection. Rejected: `memberUserIds: ObjectId[]` on the project
   row, which makes the filter a single clause with no pre-query and makes offboarding one `$pull`.
   That is genuinely cheaper, and it was rejected because the array would then be both the
   authorization authority and a field on the row every project read already loads.

4. **The four chase sites for a revoked grant are one exported function, pinned by grep.** A
   collection means four places must clear grants: the revoke route, `.../leave/route.ts`,
   `src/lib/accounts/purge.ts`, and the workspace-delete sweep. One exported
   `revokeProjectGrants({ orgId, userId })` in `src/lib/projects/lockScope.ts` is the only writer
   that clears them, it sets `isDeleted` and `revokedAt` together, and
   `tests/lib/lockedProjectLifecycle.test.ts` asserts each of those four files imports it. The purge
   batch is the dangerous one: its own comment explains how badly that unordered `Promise.all` went
   wrong once, so grants are deleted inside the batch, keyed by `orgId` and by the pre-read project
   ids, and always before the `OrgMembership` and `Org` deletes.

5. **One helper file, `src/lib/projects/lockScope.ts`, the project-shaped twin of
   `src/lib/docs/visibility.ts`.** Four exports and two caches.
   `projectGrantIds(orgId, userId)` is one indexed, `_id`-projected read of the caller's live grants,
   bounded by how many locked rooms one person is in.
   `projectVisibilityClause(grantIds)` returns
   `{ $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: grantIds } }] }` and is what the
   project filters spread. `hiddenProjectIds(orgId, userId)` returns the workspace's locked ids minus
   the caller's grants, for the places where the exclusion has to be a `$nin` on somebody else's
   field. `lockedHomeExclusion(hiddenIds)` is the one definition of "this document's home is a room
   you cannot see". Caching copies `src/lib/gating/actor.ts` exactly: a per-`Request` memo in the
   shape of its `ACTOR_CACHE`, so a route that lists projects and then documents pays once, and a
   per-process TTL map at ten seconds with an explicit `projectMembershipChanged({ orgId, userId })`
   invalidator, in the shape of its `MEMBERSHIP_EXISTS_CACHE_TTL_MS` and `membershipChanged()`,
   including the honest comment about what the other instances still serve for those ten seconds.
   Steady-state cost of the whole feature on a normal request is zero extra queries on a cache hit
   and one tiny indexed read on a miss. When a workspace holds no locked project every helper
   returns `{}` or an empty array and adds no Mongo term at all, which is what makes M1 a provable
   no-op.

6. **`hiddenProjectIds` fails closed at its cap.** It caps like `containedDocIds` does
   (`.limit(5000)` in `src/lib/docs/visibility.ts`), and past the cap it refuses the listing and
   alarms rather than returning a truncated array. A `$nin` against a truncated or empty array
   matches everything, so the naive version of this cap is a total leak wearing the costume of a slow
   page. Rejected: silent truncation, which is what `containedDocIds` does today and is defensible
   there because containment is discovery; it is not defensible for access.

7. **The four filters in `src/lib/projects/scope.ts` take a required `viewerUserId`, and the grep
   contract is the primary mechanism.** `liveProjectFilter`, `liveProjectByIdMatch`,
   `liveProjectBySlugMatch` and `slugBackfillPendingFilter` each gain the parameter and spread the
   clause into `$and`, never as a second top-level `$or` key, because a second `$or` in one object
   literal silently replaces the first and that is the bug `tests/lib/liveProjectScope.test.ts` was
   written to pin. The required parameter is a real help and it is not the guarantee: nine files in
   `src/` import those four functions, while there are sixty-six `ProjectModel`
   `find`/`findOne`/`findById`/`countDocuments`/`aggregate`/`exists` call sites across thirty-four
   files, so the type-checker enumerates about a quarter of the surface. The rest is carried by
   `tests/lib/lockedProjectSurfaces.test.ts`, a source contract in the exact idiom of
   `tests/lib/containedDocListings.test.ts`, which classifies every one of those call sites as
   filtered, recipient-exempt or admin-exempt and fails when a new one appears in neither list. The
   parameter is a `viewerUserId` and not a precomputed `hiddenProjectIds: ObjectId[]`, because an id
   is hard to invent at a call site while `[]` compiles and fails open.

8. **Every read filters; the only checks are on managing the member list.** A locked project a
   caller is not in answers 404 with a body byte-identical to a project id that never existed, on
   every route, including the by-slug path and including `slugBackfillPendingFilter`'s
   `reason: "slug_backfill_pending"` probe. Slugs are `slugify(name)`, stored lower-case and unique
   per `{ orgId, slug }`, so they are guessable by construction and any 403 on a read is a sentence
   that says "a private room with this name exists". 403 keeps exactly the meaning it has today: you
   can see this room and you lack the workspace role for this write.

9. **The project-shaped gate points, each of which inherits the clause rather than restating it.**
   `GET /api/projects` (the list, and the `?q=` regex over name **and** description, so search
   cannot read a locked room's text); `GET`, `PATCH` and `DELETE /api/projects/[projectSlug]`, the
   one route that accepts either an id or a slug and the single most important read fix;
   `GET /api/projects/[projectSlug]/docs` and `/suggested-docs`; `accessProjectForLinks` in
   `src/app/api/projects/[projectSlug]/links/shared.ts`, where one insertion into its
   `liveProjectByIdMatch` call covers seven routes (links, one link, that link's password,
   shareviews, shareviews/visits, shareviews/viewer-doc, visit-briefs) and must land **before** its
   legacy-adopt `updateOne`, so a non-member never writes to the row;
   `ProjectModel.exists(liveProjectByIdMatch(...))` in `src/app/api/metrics/events/route.ts`, where
   the presence or absence of the check is otherwise a clean existence oracle for any project id;
   and `GET /api/sidebar`, whose hand-rolled copy of the `liveProjectFilter` rule is deleted in
   favour of the import. That copy is the containment drift problem in its project form and the
   sidebar is the first place a locked room would appear, so it is fixed in M1 and not later.
   `GET /api/requests` is deliberately lock-free, because a request inbox can never be locked
   (decision 10).

10. **A request inbox cannot be locked, and the refusal is a named 400.**
    `PATCH /api/projects/:id { visibility: "locked" }` on a row with `isRequest` or a
    `requestUploadToken` answers 400 `LOCK_NOT_SUPPORTED_ON_REQUEST`, and `Project.ts`'s existing
    `pre("validate")` request-repo invariant refuses the same state as a backstop. Request inboxes
    are recipient-facing surfaces gated by capability tokens, and a member clause anywhere near
    `/api/requests/[token]/uploads`, `/guide`, `/request-view/[token]` or the `isRequest` backfill
    `updateMany` breaks inbound uploads. Rejected: relying on the schema invariant alone, which
    reaches the client as a validation failure shaped like a 500.

11. **The lock is access, not discovery, and that is a deliberate divergence from project-home
    decision 7.** Containment changes what is listed and leaves a named document reachable; a lock
    has to change what is reachable, or it is a listing filter with a padlock icon. So
    `lockedHomeExclusion(hidden)` goes into `buildDocMatch` in `src/lib/docs/docMatch.ts` as a
    required argument (the function stays pure, because its tests depend on that), which in one
    change covers `GET`/`PATCH`/`DELETE /api/docs/:id`, `/pdf`, `docs/[docId]/links/shared.ts`,
    `/shareviews`, `/shareviews/visits`, `/visit-briefs`, `/changes/**`,
    `/history/[version]/recipients` and `/viewer/[userId]`, `/contributors`, `/reviews`,
    `/share-password`, `resolveDocAnalyticsAccess` in `src/lib/analytics/docAnalyticsAccess.ts`, and
    the uploads pipeline's document lookups. And it goes into `GET /api/docs`
    **unconditionally**, outside the `if (!addressing)` guard that gates
    `workspaceListableDocFilter()`, so `?ids=<id>` and `?q=<exact slug or shareId>` do not reach a
    document whose home is a room the caller cannot see. The containment assertions in
    `tests/lib/containedDocListings.test.ts` stay green because the containment half is untouched
    and the new clause is a separate spread with its own test. Without this decision the feature is
    a listing filter: the document page, the PDF bytes, the extracted text, the AI output, every
    per-audience link slug and its password stay one guessed id away.

12. **The exclusion keys on a document's home, not on its membership.**
    `lockedHomeExclusion(hidden)` is
    `{ $nor: [{ primaryProjectId: { $in: hidden } }, { primaryProjectId: null, projectIds: { $in: hidden } }] }`,
    the same home rule `canContain()` and Slack's `routingFor()` already use. A document that also
    lives in an open project stays visible there, because the alternative lets one member silently
    withdraw shared documents from the workspace by locking a second room. The cost is real and
    accepted in decision 26: a member who compares an open room's list with the workspace list can
    infer that a locked room exists. The second arm of the `$nor` is the sharp edge: a document with
    no primary that sits in both a locked and an open room is hidden from the open room too, so
    `PATCH /api/docs/:id { addProjectId }` into a locked room sets `primaryProjectId` when the
    document has none, and the "remove from this room" action confirms before it moves a document's
    home.

13. **A `shareId` in a workspace-side payload is equivalent to the document, and is filtered as
    such.** `Doc.shareEnabled` defaults to true and `/s/:shareId` needs no workspace identity, so a
    leaked `shareId` is the document's full contents, not a hint. This rule decides four surfaces
    that would otherwise be argued as harmless metadata. `GET /api/share-links` through
    `searchShareLinks` in `src/lib/share/links.ts` runs a `$text` query with no role check and no
    visibility filter, returns `projectId`, `projectName`, `docId` and `docTitle`, and is not in
    today's contract test: it gains a post-`$lookup` `$match` dropping links whose project is hidden
    and links whose document's home is hidden. `GET /api/changes` returns title and `shareId`.
    `GET /api/uploads` and `/api/uploads/[uploadId]` list upload titles and versions scoped by
    `orgId` alone. And the realtime documents frame in `realtime/server.ts` carries `shareId`, which
    is covered by decision 18. The contract test therefore covers `DocModel` and `UploadModel` call
    sites as well as `ProjectModel` ones, because `/api/changes`, `/api/starred` and
    `/api/starred/bootstrap` are already in `containedDocListings.test.ts`'s own listing table and
    must not fall out of this one.

14. **A locked room's name is a leak, and one helper produces every name.**
    `projectNamesFor({ orgId, ids, viewerUserId })` in `src/lib/projects/names.ts` returns a name for
    a room the viewer may see and `null` for one they may not, so callers render "a private data
    room". It replaces about a dozen hydration queries that exist only to turn an id into a name:
    `src/app/api/activity/route.ts` and `src/lib/notifications/sendNotificationEmails.ts`, both of
    which have **no tenancy clause at all** today and get one as a cross-tenant fix riding along;
    `sendNotificationEmails.ts`'s second lookup; `src/app/api/docs/[docId]/route.ts` twice;
    `src/app/api/docs/route.ts`; `src/lib/contacts/service.ts`;
    `src/lib/analytics/workspace/query.ts`; `src/lib/visits/visitBriefs.ts`, which is a `findById`
    with no `orgId` and no `isDeleted`; `src/lib/slack/messages.ts` at its four sites; and
    `src/app/api/tags/by-slug/[slug]/items/route.ts`. One helper, one grep, and the two missing
    tenant clauses fixed by the same change.

15. **Contacts are a recipient-identity surface and are filtered like one.**
    `GET /api/contacts` takes `projectId` as a first-class filter (`ID_FILTERS` in
    `src/app/api/contacts/route.ts` is `["tagId", "docId", "projectId"]`) over a collection indexed
    on `{ orgId, projectIds }`, and each row carries a recipient's name and email plus
    `sources[].shareId`. So `?projectId=<locked id>` hands a non-member the locked room's reader
    list and a share link that opens the room. The same clause goes on the contacts list, the
    contact detail, the counts and the CSV export, and `?docId=` is filtered through the document's
    home. This is the surface no design in review covered, and it is the highest-value single leak
    on the list because its output is both identities and a capability.

16. **The remaining counting and listing surfaces, named so none is discovered later.**
    `GET /api/dashboard/stats` (the project aggregate and the `$expr` twin of the home exclusion in
    its `ShareView` `$lookup`, beside the containment `$expr` already pinned there);
    `GET /api/orgs/[orgId]`'s project count; `src/lib/analytics/workspace/query.ts` and
    `GET /api/metrics/workspace`; `src/lib/tags/service.ts`, `/api/tags/[tag]/docs`,
    `/api/tags/by-slug/[slug]/items` (documents **and** its `ProjectModel.find`, because tags target
    projects too), and `/api/tags/assignments` plus `/api/tags/targets`, whose
    `targetIsInWorkspace` is `{ _id, orgId, isDeleted }` with no visibility notion of any kind;
    `/api/starred` and `/starred/bootstrap`; `/api/changes`. The analytics cache is an acceptance
    criterion and not a footnote: the sixty-second LRU in `src/lib/analytics/workspace/query.ts` is
    keyed `{ org, range, plan }`, so filtering the rows and forgetting the key serves a member's
    answer warm to a non-member, which passes every cold local test and leaks in production. The key
    gains the caller's identity, or a hash of their visible set, whenever the workspace holds any
    locked project.

17. **The activity feed's exclusion is mandatory on all three paths, and the lock's own rows stay in
    the workspace feed.** `src/app/api/activity/route.ts` skips its `containedDocIds` exclusion
    whenever `?docId=` or `?projectId=` is supplied, so `?projectId=<locked id>` returns that room's
    whole feed to any viewer-role member today. The lock exclusion is not skippable: the project path
    intersects the requested id with the caller's visible set, the document path applies
    `lockedHomeExclusion`, and the workspace path applies both. A non-member gets an empty feed, not
    a 403. `GET /api/activity/summary` gains the same exclusion on both aggregates, which excludes
    nothing at all today, so a locked room's uploads inflate every member's header counts and the
    counts are an oracle. `project.locked` and `project.unlocked` are recorded with `projectId: null`
    and `meta.projectName`, which puts them in the workspace feed under the existing feed rule with
    no exemption to write and none for a future refactor to drop: a room that vanishes from ten
    sidebars with no explanation is a support ticket, and its name was already public to those ten
    people. Every row after that (`project.member_added`, `project.member_removed`,
    `project.break_glass`) carries `projectId` and therefore lives only in the room's own feed.

18. **Realtime: the name leak is fixed in the same milestone that allows a lock, per-socket filtering
    follows.** The projects change-stream watcher in `realtime/server.ts` already `$project`s
    `fullDocument.name` and broadcasts `{ type: "project", project: { id, name } }` to every socket
    in the workspace on insert, update and replace. That is a content leak, live today in a different
    shape and fatal the moment a room can be locked, so `fullDocument.visibility` joins the
    projection and a locked row's frame is skipped; the sidebar refetch it nudges is filtered anyway.
    Then, per socket: `signRealtimeTicket` in `src/app/api/realtime/ticket/route.ts` carries the
    caller's grant ids, `Client` gains the set, the activity, documents and uploads frames carry
    `projectId` (the activity frame carries only id, type and time today), a change stream on
    `projects` keeps an in-memory locked-id set seeded at boot, and `broadcast` skips a frame whose
    project is locked and not granted. Fail closed: locked with no grant is skipped. A change stream
    on `projectmemberships` sets `expiresAt = now` on affected sockets, reusing the existing polite
    close and reconnect rather than inventing a second path. The documents frame's `shareId` is what
    makes this more than timing (decision 13).

19. **The notification audience is decided at enqueue, with a send-time backstop.**
    `src/lib/notifications/queue.ts` writes one durable row per recipient and its header says a row
    means only that one person is owed one email; nothing re-derives that audience later, and the row
    itself is readable through `src/lib/admin/notificationQueueAdmin.ts`, so enqueue is the only
    enforceable point. One new helper, `notifiableMemberIds({ orgId, projectId, docId })` in
    `src/lib/projects/audience.ts`, returns all live memberships when there is no project or the
    project is open, and the room's members when it is locked. It replaces four hand-copied
    all-members queries, each of which already has the project in hand so none needs a new lookup:
    `src/app/api/share/[shareId]/stats/route.ts` for `share_views`, the three separate blocks in
    `src/app/api/uploads/[uploadId]/process/route.ts` for `doc_updates`, `doc_uploads` and
    `repo_link_requests`, and `src/lib/visits/visitBriefs.ts` for `visit_briefs`. A source contract
    greps those files for `OrgMembershipModel.find(` and fails if it reappears. The backstop is a
    third skip reason in `runGroup` in `src/lib/notifications/sendNotificationEmails.ts`, "not a
    project member", beside the "membership removed" and "member off" branches that already live
    there, which is the only place a grant revoked after enqueue can be caught. Locking a room calls
    `skipPending` for its non-members' pending rows. Two windows stay open and are said out loud in
    the dialog: mail already sent is gone, and a row already claimed by the cron between the event
    and the lock still sends, which is one batch wide.
    `src/lib/share/anonymousNoticeAudience.ts` needs no change because it only re-contacts people
    already sent a row, and gets a pinning test so a refactor cannot turn it back into a membership
    sweep. Two smaller fixes belong here: the read-receipt roster in
    `src/app/api/docs/[docId]/history/[version]/recipients/route.ts`, whose comment still reads
    "Members (all org members for now)", becomes the room's members for a document whose home is
    locked; and `visitBriefs.ts` resolves the **org owner** membership as its fallback actor, which
    for a locked room attributes the brief to someone who may not be in it, so it uses the room's
    first `editor` grant and falls back to `Project.userId`.

20. **Slack routes a locked room exactly as it routes a contained document, and the channel picker
    checks the channel.** In `routingFor` in `src/lib/slack/outbox.ts`, when the event's project or
    the document's home is locked, return `{ projectIds: [thatRoom], allowDefault: false }`, the same
    shape the contained-document branch already returns and which
    `routeSlackConnections` in `src/lib/slack/routing.ts` already honours by returning `[]` rather
    than the catch-all. `src/lib/slack/messages.ts` needs no change precisely because routing hands
    it no target, so the room name and the `/project/:slug` URL it builds never reach an unmapped
    channel. Then the limit no filter can fix: a Slack channel's audience is Slack members, not
    `OrgMembership` rows. The mitigation is not only copy. The channel picker for a locked room
    defaults to nothing, and at mapping time it reads `conversations.info` for `is_private` and
    `num_members` and hard-warns, naming the count, when a locked room is about to be mapped to a
    public or company-wide channel. The lock dialog says "Slack posts for this room stop until you
    map a channel; a locked room never posts to the catch-all", and a mapped channel's row reads
    "anyone in #deals can see this private room's activity".

21. **No bypass for owners or admins, and the escape hatch is a grant rather than a peek.** The
    clause in `scope.ts` has no role term. A workspace owner or admin who is not in a locked room
    does not see it in `/api/projects`, in the sidebar, by id, by slug, in the feed, in workspace
    metrics, in the dashboard, in the project count, in Slack or in their inbox. `requireOrgRole` is
    untouched and stays orthogonal: the filter decides whether the row comes back, the role decides
    what may be done to it. This product's whole job is controlling who sees a document, and the
    rooms people will lock are exactly the ones whose excluded reader is senior: the acquirer list
    before the founder is told, a comp review, an HR complaint about an admin, counsel's file. A lock
    an owner can read is a listing filter, and the honest sentence it forces into the create dialog
    destroys the only use the feature has. Recovery is preserved by
    `POST /api/projects/:id/break-glass`, owner role only, never admin and never an API key, with a
    `reason` of at least twenty characters, rate-limited, and answering the same uniform 404 as every
    other route so the one lock-free lookup in the product is not the enumeration oracle everything
    else removes. It does not grant a read: it inserts a `ProjectMembership` with
    `via: "break_glass"`, and the owner then sees the room as a member the existing members can see.
    It writes a `project.break_glass` row that stays in the workspace feed, sends one transactional
    email to every existing member immediately, on the `sendMemberRemovedEmail` pattern rather than
    as a sixth `NotificationQueue` kind (the kinds are a fixed union and this must not wait for a
    digest), and leaves a banner in the room's header for as long as the grant exists: "Chris Sanz
    (workspace owner) added themselves on 12 February. Reason: …". Rejected: a standing owner read
    with a `project.viewed_by_owner` trail, which gives the same operational recovery and tells
    members after the silent read rather than before it. Rejected: an admin self-add in one click,
    because the message it requires ("you are not in this room; as an admin you can add yourself") is
    a 403-shaped existence oracle plus a full read, in a product where admin is the floor for link
    writes and is handed out freely. An admin who needs a locked room asks a member or an owner.
    Personal workspaces are unaffected and the lock control is hidden entirely when
    `actor.orgId === actor.personalOrgId`, because a one-person workspace has nobody to hide from and
    a switch that does nothing is worse than no switch.

22. **There is exactly one lock-free by-id project read in the product, and it is named.**
    `liveProjectByIdMatchUnlocked()` in `src/lib/projects/scope.ts`, with exactly two callers: the
    break-glass route and `src/app/api/admin/data/projects/**`. It exists as its own export so that
    `grep` answers "what reads a project without the lock?" definitively, and the source contract
    asserts the caller count. Platform admin keeps its cross-workspace read for support, deliberately,
    and its UI labels a locked room with a padlock and its member count so an operator knows what
    they are opening. The promise is therefore worded as "nobody else in your workspace", never
    "nobody else". The admin allowlist is the most dangerous line in the contract test, because
    adding a file to it is a one-line way to turn the lock off for that surface, so each entry
    carries a stated reason and the test prints it on failure.

23. **The only 403s are on the member list, and an API key cannot touch it.**
    `GET`, `POST` and `DELETE /api/projects/:id/members`, `PATCH /api/projects/:id { visibility }`
    and `POST /api/projects/:id/break-glass` are checks rather than filters, because the caller has
    already passed the by-id filter and demonstrably knows the room exists. All of them call
    `forbidApiKey` from `src/lib/gating/forbidApiKey.ts`, the existing precedent for identity-grade
    actions: membership is identity, and identity is not delegated to a key. `GET /api/projects/:id`
    returns `visibility`, `members[]` and `visibleBecause: "member" | "break_glass"`, so the banner
    and the roster render a field rather than infer one. The roster carries a permanent line reading
    "Workspace owners: none unless added. An owner can add themselves in an emergency, and everyone
    here is told." Removing the last member of a locked room is refused with 409 and "unlock it or
    add someone first", the member set is capped at two hundred, and a grant write always records its
    activity row.

24. **The workspace role still decides what may be done, which means a locked room can need a role
    none of its members holds.** `accessProitForLinks` demands `admin` to write a link and `viewer`
    to read metrics, and the lock decides only which rooms. So a locked room whose members are all
    `member` or `viewer` cannot manage its own share links, and the only people with the role cannot
    see it. The members panel therefore names this at the moment it becomes true: "Nobody in this
    room can manage its share links. Add someone with the Admin workspace role, or ask an owner."
    Rejected: per-project roles that carry their own link-write power, which invents a second
    permission system for one button.

25. **Nothing changes for recipients, and it is pinned by test.** A data room's public link is how
    the product works. `resolveProjectLink`, `resolveProjectLinkForPage`, `ensureDefaultProjectLink`
    and `listProjectLinks` in `src/lib/share/projectLinks.ts` stay lock-free (the file's own header
    says tenancy is derived from the slug and there is no actor to check); the whole recipient half of
    `src/lib/share/projectPublic.ts`; `src/app/p/[shareId]/layout.tsx`, `(room)/page.tsx`,
    `[docId]/page.tsx`, `[docId]/pdf/route.ts` and `[docId]/preview/route.ts`;
    `/api/share/[shareId]/**` including stats and unlock; `/api/download/[token]/**`;
    `/api/request-view/[token]/**`; `/api/requests/[token]/uploads` and `/guide`. The refusal set
    (`archived`, `disabled`, `expired`, `project_gone`) gains no fifth value, and
    `tests/lib/lockedProjectRecipients.test.ts` asserts those files do **not** import `lockScope`,
    exactly as `containedDocListings.test.ts` asserts `projectPublic.ts` does not import
    `workspaceListableDocFilter`. `findProject()` in `projectLinks.ts` is owner-side and does take
    the clause. Recipient-side writes stay whole: a visit still records `ShareView`,
    `ProjectLinkView`, `DocPageTiming` and its activity rows; only the workspace-side audience for
    the resulting emails, feed rows and frames narrows.

26. **Locking is not unsharing, and the dialog says so with the fix one click away.**
    Setting `visibility: "locked"` does not touch `shareEnabled`, does not archive links and does not
    rotate `Project.shareId`, which the model documents as not secret and which never rotates:
    rotating it on lock would break rooms already sent to recipients, which is worse than the leak it
    would fix. So a room can be invisible to colleagues and open to the world at the same time, and
    that sentence is the difference between a feature and a breach report. The lock review reads the
    live `ShareLink` rows and `shareEnabled` and, when a public link is on, shows the exact
    `/p/:shareId` URL with "This data room is still shared publicly. Locking changes who in Acme can
    see it, not who outside can", and an inline "Turn off the public link too" checkbox, so the safe
    thing is one click and not a second journey through the links panel. The same consequence is
    repeated at the moment it bites again, on the members panel: "Removing someone does not change
    this room's share links. Rotate them if they should lose recipient access too." Any workspace
    member who saw the slug before the lock keeps recipient access afterwards, and so does anyone they
    forwarded it to.

27. **Writes into a locked room are filtered before they are role-checked, and auto-routing never
    sees one.** `POST /api/docs { projectId }`, `PATCH /api/docs/:id { addProjectId }` (the
    `ProjectModel.countDocuments` in `src/app/api/docs/[docId]/route.ts` that authorizes "may this
    document be put in these projects", which is today the write a non-member could use to file a
    document into a locked room and thereby see it listed) and the MCP's
    `lnkdrp_add_docs_to_project` all resolve the project through the lock filter first and reuse the
    existing 400 `PROJECT_NOT_FOUND` that project-home M1 already defines, never a new code and never
    a 403. The upload processor's auto-routing candidate set,
    `ProjectModel.find({ orgId })` in `src/app/api/uploads/[uploadId]/process/route.ts`, is a filter
    on the **uploader's** visible set, so the model is never told a locked room exists and cannot
    file into one. And the version-matching path is a check of its own: replacing or deduping a file
    onto an existing document whose home is a locked room the uploader is not in is refused as not
    found, because inheriting that document's links and readers by uploading a matching file is a
    grant, not an upload.

28. **The MCP inherits, and cannot manage membership.** `src/lib/gating/apiKeyActor.ts` resolves a
    key to a real user in one workspace and already requires `isActiveMember`, so `actor.userId` is
    the input every filter needs and there is no new identity plumbing. `mcp/src/api.ts` holds no
    database access at all, so the tools inherit the routes: `lnkdrp_list_projects` loses locked rooms
    the owner is not in, `lnkdrp_get_project`, `update_project` and `delete_project` answer not
    found, the link and project-analytics tools answer not found through `accessProjectForLinks`, and
    `lnkdrp_list_docs`, `lnkdrp_get_share`, `lnkdrp_get_share_stats`, `lnkdrp_get_activity`,
    `lnkdrp_find_share_link` and `lnkdrp_list_revisions` inherit the document, feed and search gates.
    `projectIdForSlug`'s backfill fallback keeps working because `slugBackfillPendingFilter` gains the
    same clause. `lnkdrp_create_project` gains `locked?: boolean` and seats the key's **owner** as the
    sole member, because the agent is not a member and the human is, and the tool description says so;
    an agent creating something less visible than the default is not a risk worth a refusal. Refused
    over a key through `forbidApiKey`: adding or removing project members, locking or unlocking, and
    break-glass. `lnkdrp_whoami` is gated by `verifyBearer` alone and returns
    `integrations.slack.channels[].projectIds`, so those ids are filtered or the bootstrap call names
    rooms the caller cannot open. Error copy in `mcp/src/tools/projects.ts`, `projectLinks.ts`,
    `docVisibility.ts` and `shared.ts`'s `resolveDoc` is audited so nothing answers "forbidden" where
    the design says "not found".

29. **The plan cap counts what exists, the list shows what you may see, and they disagree on
    purpose.** `src/lib/billing/planLimits.ts` keeps counting projects org-wide, through a new
    lock-free `allProjectsFilter(orgId)` split out of today's `liveProjectFilter`, because applying
    the lock there makes Free unlimited by locking. That is the exact divergence `scope.ts`'s
    docstring was written to prevent (the 2026-09-18 "used: 2, max: 1" bug), so the docstring is
    rewritten rather than worked around: the two agreed then because the list was the truth, and they
    diverge now in one direction only. The consequence is a count oracle and it is mitigated by copy,
    not by hiding: `planLimitResponse` for `projects` reads "This workspace is at its data room limit
    (some data rooms here are private)", and never "you have 2 projects". `getWorkspaceUsage().documents`
    counts shareable documents org-wide and is a second, finer oracle nobody named in review; it is
    accepted on the same reasoning and covered by the same sentence. The source contract asserts
    `planLimits.ts` imports `allProjectsFilter` and not `liveProjectFilter`.

30. **Nothing changes for existing data, and the migration writes no documents.** `visibility` absent
    reads as workspace, exactly as `Doc.visibility`'s default did when project-home shipped, so every
    existing project stays open and every existing document stays where it is. There is deliberately
    no backfill seating current members as grantees: that would write one row per member per project
    across every workspace to express the default, and the absence of grants means nothing until a row
    is locked. `db/migration/20260925_0007_projects_locked_indexes.mjs` creates four indexes with the
    idempotent `ensureIndex` helper from `db/migration/20260121_0001_projects_list_indexes.mjs`: the
    three on `projectmemberships` from decision 3, and `{ orgId: 1, visibility: 1, updatedDate: -1,
    _id: -1 }` on `projects` so the list query that 20260121 documents keeps an index once the lock
    `$or` is in it. Mongo plans each `$or` branch separately, so both branches stay indexed. M1 is
    therefore rollback-safe: drop the code and the fields are inert.

31. **Locking a room that already has documents and readers is a review, not a confirm, and it
    preselects the keepers from history.** `lockPreflight(projectId)` computes and the dialog shows,
    before the write: how many workspace members lose sight of the room, by name; how many documents
    leave workspace listings, and how many of those also live in another room and stay visible there
    (decision 12's rule made visible instead of inferred); how many share links are live, with the
    `/p/:shareId` URL and the inline "turn off the public link too" checkbox; whether Slack posts will
    stop; and that pending notifications for non-members are dropped while mail already sent stays
    sent, including a row already claimed by the cron. Then the step that decides whether the team
    absorbs the lock or loses a week: "who should keep access", preselected from what has already
    happened in the room, `Project.userId`, every uploader of its documents, and everybody with a
    `project.*` activity row for it, with the actor always in and unchecking a name as the act of
    removing access. Counting who loses access while making the locker assemble the keeper list from
    nothing is how a lock breaks a week. On confirm: set `visibility`, `lockedAt` and
    `lockedByUserId`, insert the grants, record `project.locked` in the workspace feed, and
    `skipPending` the non-members' queue rows. Unlock is the mirror, with a louder dialog, and it
    **keeps** the grants so re-locking restores the same room and an accidental unlock is not a data
    loss.

32. **Deleting a locked room is fixed before it is lockable.** The user-facing
    `DELETE /api/projects/[projectSlug]` is a hard `deleteOne` preceded by a sequence of
    untransactioned `updateMany` calls that null `primaryProjectId` and `projectId`, `$pull`
    `projectIds` and re-home from the first remaining entry, and it never clears
    `Doc.visibility`. So a contained document whose home is hard-deleted is already invisible in every
    workspace listing and in every project, while `/p/:shareId` keeps serving it. Untidy today and an
    unrecoverable publisher once a lock sits on top of it, so the same milestone that ships membership
    clears `visibility` back to `"workspace"` for documents that lose their home, deletes the room's
    grants, and makes the sequence resumable so a crash between the steps does not strand documents
    and destroy the member list that would say who to ask. Rejected: leaving the orphan alone as a
    pre-existing bug, which is defensible right up to the moment the room is private.

## Verification

1. **The helpers.** `projectVisibilityClause([])` is
   `{ $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: [] } }] }` and matches a row with no
   `visibility` field; a workspace with no locked project gets `{}` from `lockedHomeExclusion` and
   `hiddenProjectIds` and every filter is byte-identical to today's.
2. **The clause lands in `$and`.** A unit test builds each of the four `scope.ts` filters with a
   legacy-eligible actor and asserts the legacy `$or` survives, which is the second-`$or` trap
   `tests/lib/liveProjectScope.test.ts` exists for.
3. **The source contracts.** `tests/lib/lockedProjectSurfaces.test.ts` classifies every
   `ProjectModel`, `DocModel` and `UploadModel` listing call site in `src/` as filtered,
   recipient-exempt or admin-exempt, and fails on an unclassified one; it asserts `planLimits.ts`
   imports `allProjectsFilter` and not `liveProjectFilter`, that `liveProjectByIdMatchUnlocked` has
   exactly two callers, and that `/api/sidebar` imports `scope.ts` rather than hand-rolling the rule.
   `tests/lib/lockedProjectRecipients.test.ts` asserts `projectLinks.ts`, `projectPublic.ts` and
   everything under `src/app/p/**` do not import `lockScope`.
   `tests/lib/lockedProjectNotifications.test.ts` asserts the four fanout files import
   `notifiableMemberIds` and contain no `OrgMembershipModel.find(`, and pins
   `anonymousNoticeAudience.ts` as queue-derived.
4. **A member sees the room; a non-member does not.** Create a locked room as A with B added. C, a
   workspace **owner**, does not see it in `/api/projects`, `/api/sidebar`, by id, by slug, in
   `/api/activity`, in `/api/activity/summary` counts, in `/api/metrics/workspace`, in
   `/api/dashboard/stats`, in `/api/orgs/:id`'s count, in tag listings, in `/api/share-links`
   search, in `/api/uploads`, in `/api/contacts?projectId=`, or in `lnkdrp_list_projects`.
5. **The documents.** C pasting a document id from the locked room gets 404 from
   `/api/docs/:id`, `/pdf`, `/links`, `/shareviews`, `/visit-briefs`, `/changes`, `/contributors`,
   `/reviews`, `/share-password` and `/history/:v/recipients`, and 404 from `/api/docs?ids=<id>` and
   `?q=<exact slug>`, while B gets all of them. A document in both the locked room and an open room
   is still listed in the open room and in workspace search.
6. **The writes.** C cannot add a document to the locked room (`PROJECT_NOT_FOUND`, not 403), cannot
   create a document into it, cannot upload a matching file as a new version of one of its documents,
   and the auto-router never proposes it. B can do all of it subject to their workspace role.
7. **The attacker's enumeration list**, run as C against a locked room and asserted to reveal
   nothing beyond what each line accepts:
   - `GET /api/projects/<id>` and `GET /api/projects/<slug>`: byte-identical 404 bodies for a
     nonexistent id, a nonexistent slug, a locked id and a locked slug, including the
     `slug_backfill_pending` reason, and median latency within a stated tolerance across all four
     (a hidden id pays one extra indexed grant read where a nonexistent id short-circuits, so the
     refusal must be padded or the grant read taken unconditionally).
   - the same parity for `/docs`, `/suggested-docs`, the seven `accessProjectForLinks` routes,
     `POST /api/metrics/events`, `POST /api/docs { projectId }` and
     `PATCH /api/docs/:id { addProjectId }`.
   - `POST /api/projects { name }` colliding with a locked room's name: 409 whose body carries no id,
     no slug, no URL and no owner.
   - `ensureUniqueSlug`'s suffix: creating "Acme Raise" when a locked "acme-raise" exists returns
     `acme-raise-2` in a **200**, so the locked slug namespace is enumerable without ever tripping
     the name check. Asserted as a known, accepted signal with the mitigation chosen in open
     question 3.
   - `GET /api/activity?projectId=<locked>` and `?docId=<locked room's doc>`: empty feed, 200, no 403.
   - `/api/activity/summary`, `/api/dashboard/stats`, `/api/orgs/:id` and `/api/metrics/workspace`
     counts are identical before and after a room is locked, for a non-member.
   - the plan cap and `getWorkspaceUsage().documents` are the two deliberate count oracles, and the
     copy carries the "some data rooms here are private" sentence.
   - no response anywhere contains the locked room's name, slug, description or `shareId`, and no
     response contains a `shareId` belonging to one of its documents.
8. **The analytics cache.** Warm `/api/metrics/workspace` as B (a member), then call it as C in the
   same process inside the cache window: C's answer excludes the locked room. This test must run
   against a warm cache or it proves nothing.
9. **Realtime.** Create and rename a locked room while a non-member socket is open: no `project`
   frame arrives. Upload into it: no documents or uploads or activity frame arrives, and in
   particular no frame carrying the document's `shareId`. Revoke B's grant: B's open socket stops
   receiving the room's frames within the polite-close window.
10. **Notifications.** A recipient opens a locked room's link: only its members are enqueued, the
    queue holds no row for a non-member, and `notificationQueueAdmin` shows none. Replace a document
    in it, drop a file into it, finish a visit: the same, at all three
    `uploads/[uploadId]/process/route.ts` sites and in `visitBriefs.ts`. Revoke a grant after
    enqueue and before the cron: `runGroup` skips with "not a project member". Lock a room with
    pending rows: they are skipped. The version-recipients roster for a locked room's document lists
    the room's members, not the workspace.
11. **Slack.** A locked room mapped to a channel posts there; unmapped, it posts nowhere, never to
    the catch-all (extend `tests/lib/slackRouting.test.ts`). Mapping a locked room to a channel that
    `conversations.info` reports as public with a large `num_members` warns with the count.
12. **Recipients.** `/p/:shareId` for a locked room resolves for an anonymous visitor exactly as
    before, with the same refusal states, the same password and share-auth behaviour, the same
    document list, the same PDF and preview routes, and the same `ShareView`, `ProjectLinkView`,
    `DocPageTiming` and activity writes. Extend `tests/lib/roomDisclosure.test.ts` and
    `tests/lib/projectShareRefusalStatus.test.ts`. A request inbox refuses the lock with
    `LOCK_NOT_SUPPORTED_ON_REQUEST`, and `/api/requests/[token]/uploads` is unchanged.
13. **Owner and break-glass.** An owner not in the room gets 404 everywhere; break-glass is
    owner-only, refuses an API key, refuses a short reason, is rate-limited, answers the uniform 404
    for a nonexistent id, inserts a visible grant, writes a `project.break_glass` row that appears in
    the **workspace** feed, emails every existing member, and shows the banner. `project.locked` and
    `project.unlocked` appear in the workspace feed with `projectId: null`.
14. **Membership lifecycle.** Revoking a workspace membership clears that person's grants; leaving
    does the same; `org-invites/claim` reviving a revoked `OrgMembership` does **not** restore a
    cleared grant (extend `membershipRevocation.test.ts` and `inviteClaimRole.test.ts`). Removing the
    last member of a room through the members route is refused with 409, while an org-level revoke of
    that person still succeeds and the response says the room is now owner-recoverable only.
    `src/lib/accounts/purge.ts` removes grants by `orgId` and by project id before the membership and
    org deletes (extend `accountPurge.test.ts`, `purgeCompleteness.test.ts`,
    `purgeOrgRowsLast.test.ts`).
15. **Delete.** Deleting a locked room clears `Doc.visibility` for documents that lose their home, so
    no document is left contained with no project, and removes its grants.
16. **Plan limits.** Locking a project does not move `used: N` (extend
    `tests/credits/planLimits.test.ts`), and the copy carries the privacy sentence.
17. **MCP.** `lnkdrp_create_project { locked: true }` seats the key's owner; the members, lock and
    break-glass routes refuse a key; `whoami` filters `projectIds`; every tool that hits a locked room
    renders "not found" rather than "forbidden". Extend `mcpProjectSlugLookup`,
    `mcpProjectLinkWrites`, `mcpProjectPublicUrl`, and add a locked case to `mcp/e2e.ts` and
    `mcp/freeplan.ts`.
18. **The non-vitest harnesses.** `tests/routes/sidebar-snapshot.mjs` and
   `tests/routes/received-vs-projects.mjs` snapshots are re-run unchanged, as the proof that the
   default is inert; `share/seed-corpus*` and `share/traffic-corpus.ts` gain a locked room so the
   recipient corpus covers one. `npm test` chains three vitest configs, so the gate uses `pipefail`
   or `PIPESTATUS`: a grep after `npm test` has hidden a failure here before.

## Milestones

**M1 — The field, the filter and the project-shaped reads.** `Project.visibility`, `lockedAt`,
`lockedByUserId` with the hot-reload schema patch; `ProjectMembership`;
`db/migration/20260925_0007_projects_locked_indexes.mjs`; `src/lib/projects/lockScope.ts` with the
request memo, the ten-second TTL cache and `projectMembershipChanged()`; `allProjectsFilter` split
out of `liveProjectFilter` and `planLimits.ts` pointed at it; the required `viewerUserId` on the four
`scope.ts` builders and every resulting call site fixed; `/api/sidebar`'s hand-rolled copy deleted;
`accessProjectForLinks`; `/api/metrics/events`; `POST /api/projects { locked: true }` seating the
creator. Nothing is lockable from the UI yet, and with no locked rows this ships as a provably
behaviour-neutral refactor. The three source contracts land here, because they are the mechanism and
not the documentation.

**M2 — Lock it, man it, and fix what a lock would make unrecoverable.**
`PATCH /api/projects/:id { visibility }` at `requireOrgRole("member")` with the review token and
`LOCK_NOT_SUPPORTED_ON_REQUEST`; `GET`/`POST`/`DELETE /api/projects/:id/members` with `forbidApiKey`,
the last-member 409 and the two-hundred cap; `visibleBecause` and `members[]` in the project DTO;
`revokeProjectGrants` wired into revoke, leave, purge and the org sweep; the `project.locked`,
`project.unlocked`, `project.member_added` and `project.member_removed` rows; the `DELETE` orphan fix
and grant cleanup from decision 32; and the realtime projects watcher's name leak, because that frame
already broadcasts a project's name to every socket in the workspace and the first lock would
broadcast the room's name to every open tab. Members UI on the project page.

**M3 — Documents and every by-id surface.** `lockedHomeExclusion` threaded into `buildDocMatch` and
therefore about twenty routes; `/api/docs` on the browse and the addressing path; `/api/uploads` and
`/api/uploads/[uploadId]`, the processor's auto-routing candidate set and the version-matching
refusal; `searchShareLinks`; the tag routes, the tag service, `/api/tags/assignments` and
`/api/tags/targets`; `/api/changes`, `/api/starred`, `/starred/bootstrap`; `/api/dashboard/stats`
including the `$expr` twin; `/api/orgs/:id`; `src/lib/analytics/workspace/query.ts` including its
cache key; `/api/contacts`, the contact detail and the CSV export; and `projectNamesFor` replacing the
dozen name hydrations, which tenants the three that have no `orgId` clause today. This is the
milestone that turns the lock from a listing filter into access control.

**M4 — Feed, metrics events and realtime.** The mandatory exclusion on all three `/api/activity`
paths and both `/api/activity/summary` aggregates; the ticket's grant set, `Client.grants`,
`projectId` on the activity, documents and uploads frames, the `projects` locked-id change stream
seeded at boot, the fail-closed skip in `broadcast`, and the `projectmemberships` stream that expires
affected sockets through the existing polite close. Extends `feedVisibility.test.ts` and
`docMetricsScope.test.ts`.

**M5 — Notifications and Slack.** `src/lib/projects/audience.ts`; the four fanout sites converted;
the send-time skip reason in `runGroup`; `skipPending` at lock time; the version-recipients roster;
`visitBriefs.ts`'s fallback actor; `routingFor`'s locked branch; the `conversations.info` check and
the empty-by-default channel picker; `whoami`'s channel filter.

**M6 — Break-glass.** `liveProjectByIdMatchUnlocked` with its two pinned callers;
`POST /api/projects/:id/break-glass`, owner-only, reason required, rate-limited, uniform 404; the
workspace-visible `project.break_glass` row and its label; the immediate email to existing members;
the persistent header banner. This must land before the option reaches users, because M2's org-level
revoke can already leave a memberless locked room and this is the only way back into one.

**M7 — The surfaces and the honesty.** The create dialog's lock option with its copy; the lock review
with its counts, the history-preselected keepers and the inline public-link checkbox; the unlock
review; the Locked pill and the roster with its permanent owners line; the break-glass banner; the
"nobody here can manage this room's links" line; personal-workspace suppression; the plan-limit copy;
the app's ordinary not-found for a non-member following a `/project/<id>` URL, with no request-access
affordance. The user-facing option turns on here, and not before: locking a room in the M1 to M4
window would give a materially weaker guarantee than the dialog promises.

**M8 — MCP, oracles and documentation.** `locked` on `lnkdrp_create_project`; `forbidApiKey` on the
identity routes; the error-copy audit; `mcp/e2e.ts` and `mcp/freeplan.ts`;
`tests/lib/lockedProjectOracle.test.ts` in the idiom of `projectPdfOracle.test.ts` and
`adminSearchOracle.test.ts`, covering the whole enumeration list including latency parity;
FEATURES.md, MCP.md, CHANGELOG, and the release note sentence about what a lock does not do.

## Open questions

1. **Does an admin get any path into a locked room?** Recommendation: no. Break-glass is owner-only
   because `owner` is the billing identity and `admin` is handed out freely in this product (it is
   only the floor for link writes). An admin who needs a room asks a member or an owner. Revisit if
   support load says otherwise, and if so make it the same grant with the same email, never a read.
2. **Should locking a room also contain its documents?** Nothing in the repo sets
   `Doc.visibility: "project"` when a document is added to or uploaded into a project; only an
   explicit `PATCH` does. So containment and the lock never converge on their own, and a document
   uploaded into a locked room after the lock is `visibility: "workspace"` and would be listed in
   workspace search were it not for decision 11's home exclusion. Recommendation: the lock does not
   rewrite `Doc.visibility` (a one-way bulk mutation of existing rows, defaulted on, is the worst
   thing this design could contain), and instead `Project.containNewDocs` from project-home open
   question 1 defaults to **on** for a locked room, so new documents there are contained by birth and
   nothing existing is rewritten.
3. **What to do about `ensureUniqueSlug`'s suffix.** Creating "Acme Raise" against a locked
   `acme-raise` returns `acme-raise-2` in a 200, which enumerates the locked slug namespace without
   tripping the name check. Recommendation: accept the name 409 (per-viewer uniqueness would let two
   live rooms share a slug and break `liveProjectBySlugMatch`, which is a correctness failure) and
   close the suffix by appending a short random token instead of a counter when the colliding row is
   one the caller cannot see. The caller's own slug is then unremarkable and the probe returns
   nothing.
4. **Is there a tenant-side answer to "which rooms are locked and who is in them"?**
   Recommendation: yes, and it is the reason grants are a collection with `revokedAt`. Ship an
   owner-only `GET /api/orgs/:orgId/locked-rooms` in a follow-up that returns counts and the room
   names an owner has grants for, plus a per-room "who has ever been in this room" history for its
   own members. Without it the first compliance request arrives as an ad-hoc database query by
   platform staff, which is the outcome the no-bypass rule exists to avoid.
5. **Does a re-added member read the window they were out of?** Recommendation: yes. The room keeps
   its whole feed and its documents, and membership is present-tense, because the alternative is a
   per-row grant window nothing in the schema can express today. Say it in the members panel: "Adding
   someone shows them everything in this room, including what happened before they joined."
6. **What happens to a locked room on a downgrade or over the plan cap?** Recommendation: nothing.
   The lock is not a paid feature, it survives a downgrade, a lapsed subscription and the
   over-cap state, and the cap only refuses new rooms. Gating privacy behind a plan is the wrong
   sentence to have to write.
7. **Who inherits a locked room when the owner leaves?** Recommendation: on an owner handover, the
   new owner inherits break-glass and nothing else, and the departing owner's `break_glass` grants are
   revoked with their membership like any other grant. A room whose members have all left is
   break-glass-recoverable by the new owner, and the handover screen says so.
8. **In-flight references across a lock.** A pending download-request approval, the review agent
   working a request inbox's guide document, a brief being rendered, and an MCP agent halfway through
   a task all hold a project id across the boundary. Recommendation: treat a lock as a soft boundary
   for work already in flight (it completes) and a hard boundary for anything that starts afterwards,
   and give the MCP one distinguishable signal, a `PROJECT_NOT_FOUND` with
   `reason: "visibility_changed"`, which is safe because that agent had the id legitimately a moment
   ago.
9. **Slack when the only mapped channel is the catch-all.** Recommendation: lock anyway and stop
   posting, with the dialog naming it. Silence is the correct failure for a room whose point is
   silence, and the contained-document rule already behaves this way.
