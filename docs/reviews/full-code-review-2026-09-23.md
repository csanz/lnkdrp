# Full code review — 2026-09-23

Scope: the whole repo (~91k lines TS/TSX), split across eight parallel reviewers by area: docs/uploads/blob, public share surface, billing/orgs/auth, admin/cron/analytics, projects/notifications, MCP/realtime/AI, authenticated frontend, and infra/models/tests. Every finding below was verified by reading the code paths involved; the high-severity ones were re-checked by hand afterwards. Style, naming and JSDoc gaps were deliberately excluded.

Overall: the security foundations are strong. Tenancy is bound in the query nearly everywhere, the share password gate ordering is correct on every route traced, blob dereferences go through the SSRF allowlist, admin and cron guards are complete, and crypto primitives are done right. The real problems are lifecycle edges (capabilities that never expire, Stripe subscriptions that outlive their owner), a few jobs whose math is wrong under partial windows, several UI dead-ends, and missing test/CI coverage on the money path.

| Severity | Count |
|---|---|
| High | 10 |
| Medium | 35 |
| Low | ~50 |

---

## High

### H1. Upload secret is a permanent write capability; a recipient can silently swap the bytes of a completed version
- `src/app/api/blob/upload/route.ts:144`, `src/app/api/uploads/[uploadId]/route.ts:403-452`, `src/app/api/uploads/[uploadId]/process/route.ts:908-947, 1085-1105, 1910, 1964, 1998`
- `uploadSecret` is minted by the request-link and replace-link routes and never cleared or expired (no `$unset`/`null` write anywhere in `src/`). All three secret-auth surfaces check `{ _id, uploadSecret, isDeleted }` with no status guard.
- Scenario: a recipient uploads via `/r/:token`, owner reviews. Later the recipient reuses the secret: `POST /api/blob/upload` → new bytes → `PATCH /api/uploads/:id { status: "uploaded", blobUrl }` → `POST .../process`. The claim succeeds (`uploaded → processing`), the job reuses the old preview and slides but re-extracts text from the new bytes and rewrites `blobUrl`. No new version, no `DocChange`, no email (deduped on `uploadId`).
- Fix: `$unset` `uploadSecret` on first transition to `completed`, and refuse secret-auth on `blob/upload`, `PATCH`, and `process` unless `status ∈ {uploading, uploaded}`.
- **Closed 2026-09-25.** The secret is not cleared, because the recipient page keeps polling `GET` with it until the document is ready. Instead each write surface matches the status in its own filter (`src/lib/uploads/secretAuth.ts`): Blob token and PATCH need `uploading|uploaded`, process needs `uploaded|processing|failed`. A completed row answers the same 404/403 as a wrong secret. Verified live against the dev server on a completed and an uploading row; `tests/upload/secretAuth.test.ts`.

### H2. Deleting a team workspace leaves its Stripe subscription billing forever
- `src/app/api/orgs/[orgId]/route.ts:160-172`
- DELETE soft-deletes org, memberships, invites, docs, uploads, but never touches `SubscriptionModel` or Stripe. The only Stripe subscription mutations in the repo are `resume` and `purge`. The portal requires the org to be the actor's active org, which needs a live membership, so nobody can reach the portal for that customer again.
- Fix: cancel the subscription before the soft-delete (or refuse with 409 while `isBillableSubscription`), and mark the Subscription row deleted.

### H3. Checkout mints a second subscription while the first is past_due/unpaid; the webhook then flips the row between them
- `src/app/api/stripe/checkout/route.ts:147`, `src/app/api/stripe/webhook/route.ts:420-429`
- The 409 guard uses `isBillableSubscription` (active|trialing only). `past_due`/`unpaid`/`incomplete` pass, so a second Checkout creates subscription B. The webhook keys subscription events by `metadata.orgId`, never by stored `stripeSubscriptionId`, so events from A or B overwrite the single row.
- Scenario: card declines → A past_due → Upgrade → B active. A later emits `updated` (unpaid, or active after retry) → row becomes A/unpaid → workspace loses Pro while paying for B, or double-billed.
- Fix: treat any non-terminal subscription as "manage in portal" in checkout; in the webhook ignore subscription events whose `sub.id` differs from the stored one.

### H4. MCP: unauthenticated 66 MB body guard is bypassed by any `Bearer lnk_x` header
- `mcp/src/main.ts:62-67, 260-267`
- The `/mcp` pre-parser guard only checks the bearer *starts with* `lnk_`; the key is not verified before `express.json({ limit: ~66 MB })` buffers the body.
- Scenario: `POST /mcp` with `Authorization: Bearer lnk_anything` and a 66 MB body, six in parallel → 512 MB Fly machine OOMs, every session dropped. No key needed.
- Fix: large limit only when `mcp-session-id` names a live session whose key hash matches; 100 KB otherwise.

### H5. `copy_to_new_project` delete mode issues a self-conflicting Mongo update and always fails after creating the new project
- `src/app/api/projects/[projectSlug]/route.ts:579-591`
- `$addToSet: { projectIds }` and `$pull: { projectIds }` in one `updateOne` → MongoDB `ConflictingUpdateOperators`. No try/catch around the loop; `ProjectModel.create` at :549 already ran.
- Scenario: DELETE a request repo with ≥1 doc in this mode → 400 with driver text, repo not deleted, orphan "(imported)" project; each retry creates "(imported) (2)", "(3)"… counting against the Free cap.
- Fix: two updates (`$pull` then `$addToSet`) or compute and `$set` the array; roll back the created project on failure.
- **Closed 2026-09-25.** Two updates per document; on any failure the new project is deleted again before the error surfaces. The conflict was reproduced against the dev database ("would create a conflict at 'projectIds'") and the two-step form checked.

### H6. `usage-agg-reconcile` overwrites `UsageAggCycle` totals with a partial-window sum
- `src/lib/usage/reconcile.ts:79-104, 130-152`, `src/app/api/cron/usage-agg-reconcile/route.ts:63-83, 110`
- Cycle aggregate matches ledger rows by `createdDate` in the window, groups by `cycleKey`, and writes with `$set`. Any cycle extending outside the window is replaced by the in-window portion. `getCreditsSnapshot` (fast path), `/api/billing/summary`, `/api/billing/spend` read this figure.
- Scenario: `?start=2026-09-22&end=2026-09-22` → every workspace's current cycle `totalUsedCredits` becomes one day's sum; on-demand spend cap check understated until the next hourly run. The default 45-day window truncates any cycle older than 45 days.
- Fix: for cycle rows, recompute each `cycleKey` seen in the window over its full row set (drop the `createdDate` bound).
- **Closed 2026-09-25.** The window now only selects which (workspace, cycleKey) pairs to touch; each is re-summed over all its rows (`cycleRowsMatch`). `tests/lib/usageReconcile.test.ts` drives a one-day window over a month-long cycle and checks the written total is the cycle's.

### H7. Frontend: "vN · History" chip on the History page locks the whole app behind an opaque overlay
- `src/app/providers.tsx:104-115, 121-148`, `src/components/doc/DocIdentityRow.tsx:120`, `src/app/(app)/doc/[docId]/history/pageClient.tsx:691`
- `shouldTriggerForTarget` fires for any `/doc/` href `!== pathname`; the overlay and nav lock release only on `usePathname()` change. The chip's href is `/doc/:id/history#v-N`, same pathname plus hash → overlay (z-index max, opaque) never releases; every link click is `preventDefault`ed until hard reload.
- Fix: compare without hash/query, and add a fallback timeout / `popstate` release.
- **Closed 2026-09-25.** `navPathOf` compares the pathname only; the overlay also releases on `hashchange`, `popstate`, and after 15 s without a pathname change. `tests/lib/navPathOf.test.ts`.

### H8. Frontend: invite modal on `/preferences` refetches `/api/org-invites` in an infinite loop
- `src/app/preferences/WorkspaceManager.tsx:152-160`
- `loadExistingInvites` lists `existingInvites` in its deps but only writes it; each response sets a new array → new callback → effect re-runs (also wiping `inviteLink`). `TeamsManager.tsx:352` already has the correct deps.
- Fix: drop `existingInvites` from deps, or delete the stale `/preferences` copy.

### H9. Frontend: invoices never load for owners on a cold load of the Billing tab
- `src/app/dashboard/BillingInvoicesTab.tsx:666-670, 719`
- Effect returns early when `canManageBilling` is false (plan `null` on cold cache) and `canManageBilling` is not in the deps → never refires → skeleton forever. Masked when arriving from Overview.
- Fix: add `canManageBilling` to the deps.

### H10. Stripe webhook handler (745 lines) has no test coverage; no CI; no umbrella test script
- `src/app/api/stripe/webhook/route.ts`, `package.json:39-44`, `.github/` (only a PR template)
- Nothing under `tests/` imports the webhook route. The `lastStripeEventAt` ordering guard and the `StripeEvent` insert-before-process contract are enforced only in this untested file. The four vitest suites have no `test` script and nothing runs them.
- Fix: add `tests/lib/stripeWebhook.test.ts` pinning duplicate-event ack, failed-first-attempt retry, and out-of-order ignore; add a `test` script and a GitHub Actions workflow (exclude `tests:agent:vitest`, which calls OpenAI live).

---

## Medium

### Billing / identity
- **M1. Account deletion leaves shared-workspace subscriptions charging the departed owner's card.** `src/app/api/account/delete/route.ts:60-99`, `src/lib/accounts/purge.ts:277-300`. Purge cancels only `soloOrgIds`; for a team, the leaver's membership goes but the Subscription (their card) stays active. Solo Pro also takes one more charge during the 30-day grace. Fix: set `cancel_at_period_end` on every subscription whose customer is this user, or require ownership transfer first.
- **M2. Webhook ordering guard + upsert throws E11000 on every out-of-order event → 400 + 3 days of Stripe retries.** `src/app/api/stripe/webhook/route.ts:471-495`. `orderedQuery` adds `lastStripeEventAt <= event.created` but `upsert: true` remains; a stale event matches nothing, tries to insert, hits the unique `{orgId}` index. The "ignored out-of-order" branch is unreachable. Fix: read-then-upsert, or catch 11000 as the no-op.
- **M3. Account deletion "unshares" a field that does not exist.** `src/app/api/account/delete/route.ts:82` writes `isShared: false`; the schema has `shareEnabled`. `docsUnshared` is always 0. Link update is scoped to `orgId in ownedOrgIds`, excluding legacy `orgId: null` docs, which `resolveShareLink` will then mint an enabled default link for. Fix: use `shareEnabled` via `syncDocShareState`/`setAllLinksEnabled(false)` and purge's `legacyOwned` filter.
- **M4. Collaborator cap exceeded by redeeming two invites concurrently.** `src/app/api/org-invites/claim/route.ts:167-182, 204-210`. Per-token atomic claim, but `checkLimit("collaborators")` counts before either write. Fix: re-count after the write and roll back over cap. **Closed 2026-09-25:** re-counted after the membership write; over the cap the row is removed (or re-deleted), the invite released, and the same 402 answered. `tests/lib/orgInviteClaimOverCap.test.ts`.

### Docs / uploads
- **M5. Failed replacement leaves the doc stuck in `preparing` with no repair path.** `src/app/api/uploads/route.ts:354-358`, `doc/update/[code]/uploads/route.ts:189-193`, `process/route.ts:1248, 1832, 1854, 3026`, `docs/[docId]/route.ts` (repair block). Doc is moved to `preparing`/new `currentUploadId` before bytes exist; every failure path is `if (!isReplacement)` guarded so nothing restores it. Read-time repair only matches `uploading && !blobUrl`. Fix: restore to newest `completed` upload on replacement failure; extend repair to `failed`. **Closed 2026-09-25:** `src/lib/uploads/restoreDocAfterFailure.ts` is the one restore routine; every replacement failure path in the job (missing blob, fetch failure, failed run, crash) and the import abandon path call it, and the read-time repair also catches `preparing` behind a `failed` upload. Verified live: a replacement whose PDF 404s leaves the document `ready` on its previous upload.
- **M6. Processing job auto-attaches docs to projects from every workspace the uploader belongs to.** `process/route.ts:1221-1237, 3011-3016`. `ProjectModel.find({ userId })` has no `orgId` bound; AI routing context and `projectIds` writes cross workspaces. `PATCH /api/docs/:id` forbids exactly this. Fix: scope to `{ orgId: existingDocOrgId }`. **Closed 2026-09-25:** the project lookup and both request-project lookups are scoped to the document's workspace.
- **M7. Process job ignores a deleted/archived document: still bills credits, flips it to `ready`, emails every member.** `process/route.ts:1212-1219` (computed, never read), `:127-141`. Fix: bail before any reservation if `isDeleted`; add `isDeleted: { $ne: true }` to `updateDocUnlessSuperseded`. **Closed 2026-09-25:** the job fails the upload and returns before any reservation when the document is deleted, and `updateDocUnlessSuperseded` never matches a deleted document. Verified live on a deleted document.

### Public share
- **M8. Locked data room answers 404 vs 401 per candidate docId on `download-requests`.** `src/app/api/share/[shareId]/download-requests/route.ts:104-128`. `resolveProjectStatsTarget` runs before `shareLinkUnlocked`; SECURITY.md §7.8's "third door" oracle, fixed on stats and pages but not here. Fix: resolve link → unlock check → then `findProjectDocument`.

### Admin / cron
- **M9. Nightly `analytics-reconcile` does three full-collection scans in one 300 s function.** `src/app/api/cron/analytics-reconcile/route.ts:76-103`, `src/lib/analytics/reconcileLinkCounters.ts:75-91, 116-118`. Range on `lastViewedAt`/`lastEventAt` alone cannot use the compound indexes (leading `docId`/`shareId`); plus unfiltered `$group` over `shareviews` and `find({})` over `sharelinks`. No lease. Fix: iterate per org or add leading-field indexes; bound with a lease.
- **M10. Admin credits page looks up the cycle aggregate with the wrong key format.** `src/app/api/admin/credits/purchases/route.ts:123-132` builds `sub_…:<unix>` (grant key); usage rows are `<orgId>:<ISO>`. Always 0. Fix: use `cycleKeyForUsage`. **Closed 2026-09-25:** `src/lib/credits/cycleKey.ts` holds the usage key; the admin route builds it from the balance row's `currentPeriodStart`. `tests/lib/cycleKeyForUsage.test.ts`.
- **M11. Migration builds partial indexes the runtime cannot use.** `db/migration/20260107_0001_teams_query_indexes.mjs:37-50`. `partialFilterExpression: { isDeleted: false }` vs runtime `isDeleted: { $ne: true }` → planner refuses; `find({ userId })` on memberships is a collection scan on every app load (`/api/orgs`). Schema still declares plain `index: true` under the same names → `IndexOptionsConflict` swallowed. Fix: drop the partial filter, or switch queries to `isDeleted: false` and align the schema. **Closed 2026-09-25:** `db/migration/20260925_0001_orgmemberships_plain_indexes.mjs` drops the partial `userId_1` / `orgId_1` and recreates them plain, matching the schema. Verified on the dev database: `find({ userId })` is back on `userId_1` (it had fallen to the boolean `isDeleted_1` index).
- **M12. `?dryRun=1` overwrites the real `CronHealth` record on five jobs.** `notification-emails`, `plan-limits`, `visit-briefs`, `credits-cycle-reconcile`, `analytics-reconcile` routes. `account-purge` correctly skips. Fix: gate health writes on `!dryRun`. **Closed 2026-09-25:** `writeCronHealth` in `src/lib/cron/health.ts` is a no-op on dry runs; all fifteen writes in the five routes go through it. `tests/lib/cronHealthDryRun.test.ts`.
- **M13. `/api/admin/shareviews/doc/:docId` is unbounded.** `src/app/api/admin/shareviews/doc/[docId]/route.ts:38-83`. Fix: `?limit` (cap 500) + cursor.

### MCP / AI
- **M14. Destructive-tool confirmation degrades to the agent's own `confirm: true` on headless/cancelling clients; docs/MCP.md claims the opposite.** `mcp/src/confirm.ts:182, 195-203, 221`, `docs/MCP.md:24`. Fix: pick one policy; at minimum refuse a pre-set `confirm: true` on the call that produced the cancel; fix the doc.
- **M15. Document titles reach the agent unwrapped in the confirmation error message.** `mcp/src/confirm.ts:149-155, 163, 224` and tool callers. Titles are model-derived from PDF text; every read tool wraps them, this path does not, on exactly the path where `confirm: true` is the gate. Fix: `sanitizeUntrustedText` on headline/facts.
- **M16. Inline uploads let one write key exhaust memory: 66 MB base64 accepted, Ghostscript + pdfjs unbounded.** `mcp/src/tools/sharePdf.ts:139-146, 230, 243`, `mcp/src/optimize.ts:276-297`. The app rejects >4.5 MB anyway. Fix: cap at the platform ceiling; semaphore Ghostscript/pdfjs.
- **M17. No cap on MCP sessions per key or in total.** `mcp/src/main.ts:164-232, 342-349`. One key looping `initialize` at 300/min → ~18k live sessions in the idle window. Fix: per-key and global caps.

### Infra / models
- **M18. Catch-alls map infrastructure failures to HTTP 400 and skip ErrorEvent logging.** `src/lib/http/errorResponse.ts:77-88, 99-104` and 12 routes (`docs`, `sidebar`, `share/stats`, `unlock`, `landing`…). `errorJson` logs only for `status >= 500`. Fix: use 500 in catch-alls, or log whenever `code === UNHANDLED_EXCEPTION`.
- **M19. `ErrorEvent.stack` stored unredacted.** `src/lib/errors/logger.ts:410-446`, `serializeErrorEvent.ts:58`. `Error.stack` begins with the raw message, so emails/URIs redacted from `message` survive in `stack` and render in `/a`. Fix: `redactLogText` on both.
- **M20. Plaintext capability tokens on `Project` ship to the realtime host via the change stream.** `src/lib/models/Project.ts:45, 52`, `Upload.ts:50`, `Doc.ts:239`, `realtime/server.ts:439-456`. The `projects` watcher has no `$project`, unlike `docs`/`uploads`. Fix: project the watch to `_id, orgId, name`; hash tokens at rest. **Watch projected 2026-09-25** to `_id, orgId, name`; tokens are still plaintext at rest.

### Frontend
- **M21. `Markdown` renders every inline code span as a block and nests `<pre>` in `<pre>`.** `src/components/Markdown.tsx:177-215` branches on `inline`, removed in react-markdown v9. `HelpMarkdown.tsx:55-75` does it right. Fix: detect by `language-` class; override `pre`.
- **M22. App-shell auth gate spins forever after a recovered session.** `src/app/(app)/AppShellLayout.tsx:99-102, 146, 153`. `router.refresh()` does not update next-auth client state. Fix: call `getSession()`/`update()` or keep polling until `status` flips. **Closed 2026-09-25:** the gate calls next-auth `update()` before refreshing and keeps polling until `status` flips; after three ignored confirmations it shows a sign-in link.
- **M23. Every live refresh of doc metrics blanks the viewer list.** `src/components/metrics/MetricsView.tsx:1409-1412, 1547-1600, 2759, 3452-3458`. Silent refresh uses the lite request (`viewers: []`) and replaces the whole payload. Fix: merge, keeping `prev.viewers` until the viewers response lands. **Closed 2026-09-25:** `mergeSilentRefresh` in `src/lib/client/metricsPayload.ts`; a silent refresh keeps the previous viewer lists. `tests/lib/metricsPayload.test.ts`.
- **M24. Free workspaces are emailed a reader link that lands on "No reader by that id".** `src/components/metrics/ViewerProfile.tsx:189-205, 569-578`, `src/lib/notifications/viewNotifications.ts:750-752`. Fix: omit `readerUrl` for non-Pro or show the upgrade block. **Closed 2026-09-25:** the email builds `readerUrl` on Pro only (Free's primary button goes to the metrics page); `ViewerProfile` shows the analytics upgrade block on the basic tier instead of "No reader by that id".
- **M25. Client-side first-page thumbnail silently never renders.** `src/lib/client/docUploadPipeline.ts:74-80`, `doc/update/[code]/pageClient.tsx:74-80`, `r/[token]/pageClient.tsx:68-72`. `disableWorker` does not exist in pdf.js 5 and no `workerSrc` is set; the fallback rejects and the catch returns null. Fix: set `GlobalWorkerOptions.workerSrc` or reuse the shared `workerPort`.
- **M26. History list races on sort/page-size change; stale cursor then paginates the wrong query.** `history/pageClient.tsx:416-442, 499-513`. Fix: pass the cancel token into `refreshFirstPage`.
- **M27. Project settings: guide-upload errors swallowed after the modal closes.** `project/[projectSlug]/pageClient.tsx:758-855`. Review enabled with no guide. Fix: keep the modal open until the guide flow completes, or upload before enabling.
- **M28. Project docs list shows "Loading…" forever on any non-404 error.** `project/[projectSlug]/pageClient.tsx:276, 316`. Fix: clear loading and set an error on `!res.ok`.
- **M29. Out-of-credits banner disappears after any realtime or credits-refresh event (stale closure).** `src/app/dashboard/dashboardShell.tsx:152-221, 259-271, 306`. Fix: refs for `activeOrgId`/`orgReady` inside `refreshCredits`. **Already fixed** in the tree by 2026-09-25 (`activeOrgIdRef` / `orgReadyRef`).
- **M30. `AccountMenu` force-refetches `/api/orgs` on every window focus.** `src/components/AccountMenu.tsx:354-402`. Effect keyed on `session?.user` (new object per session refetch) with `force: true`. Fix: key on email, drop force.
- **M31. "Import from a link" leaves an orphan "Untitled document" on every failed import.** `src/app/HomeAuthedClient.tsx:171-188`. Fix: delete the doc on failure or create it after fetch. **Closed 2026-09-25** on the client: the import flow deletes the document it created on any failure after creation. A tab closed mid-fetch can still leave one; moving creation after the fetch in the import route would close that.
- **M32. Components declared inside render remount on every parent render.** `src/app/dashboard/SubscriptionCard.tsx:163-196` (`PlanPanel` → `SpendLimitModule` loses edit state), `src/app/dashboard/page.tsx:316-402` (`DashboardMenu`). Fix: hoist to module scope.
- **M33. "All pages" mode cancels every in-flight page render on each scroll tick.** `src/components/PdfJsViewer.tsx:1601-1649, 1665-1771`. Fix: only cancel tasks outside the new `toRender` set; drop `pageNumber` from deps.
- **M34. Forced sidebar refresh can coalesce onto a stale in-flight request, resurrecting a just-deleted doc.** `src/lib/sidebarCache.ts:434-437, 477-481`. Fix: when `force` and in-flight, chain a second fetch.
- **M35. Realtime change-stream failure at startup reports healthy for 30 s, then crash-loops.** `realtime/server.ts:303-323, 843-869`. Streams are lazy; a non-resumable error (code 13) surfaces only after the first listener. Fix: probe each stream before `listen` and exit immediately on 13/40573 with the error named.

---

## Low

### Public share
- Membership lookup runs on the locked path (timing side-channel) in `p/[shareId]/[docId]/page.tsx:100-108`, `share/[shareId]/stats/route.ts:267-269, 426-428`.
- Raw `err.message` to anonymous callers: `share/[shareId]/stats/route.ts:327-328`, `requests/[token]/uploads/route.ts:371-376`, `requests/route.ts:261-263`.
- Share-auth cookie compared with `===` in `src/lib/share/links.ts:164` and eleven inline copies; use `timingSafeEqual` in `shareLinkUnlocked` and call it everywhere.
- Download-request dedupe ignores `docId` (`download-requests/route.ts:161-175`), so a second room doc request within 60 s is dropped.
- Room request emails link to `/s/<projectSlug>` which 404s (`download-requests/route.ts:224, 251`); use `buildPublicProjectUrl`.
- `og:image` for locked/refused `/s/` links points at a 404 (`s/[shareId]/page.tsx:106-130`); pass `previewUrl: null` like `/p/`.
- `resolveShareLink` writes on an anonymous GET for a soft-deleted legacy doc (`src/lib/share/links.ts:368-378`).
- `page-image` echoes upstream `content-type` (`s/[shareId]/page-image/route.ts:119`); sniff like `pinnedImageMime`.
- `og.png` selects the entire `aiOutput` (`og.png/route.tsx:82-84`); project the three sub-fields.
- Link resolved 3–4× per public page render (layout + metadata + page); wrap resolvers in `React.cache()`.
- Room grid fans out one buffered blob fetch per document per viewer (`p/[shareId]/(room)/page.tsx:167, 225-231`); add ETag handling or thumbnails.

### Docs / uploads
- `POST /api/uploads` re-fetches the doc by `userId` after minting a `shareId` (`uploads/route.ts:277-281`), giving a teammate an upload with `orgId: null`.
- `GET /api/uploads/:id` resolves the doc by `userId` (`uploads/[uploadId]/route.ts:143-151`), returning `doc.status: null` to teammates.
- `GET /api/docs/:id?lite=1` fetches the current upload unscoped (`findById`) unlike the non-lite path.
- Two paths hand out a stored `blobUrl` without the allowlist: `docs/[docId]/pdf/route.ts:448-456` (302 to raw url), `download/[token]/save/route.ts:214`.
- `GET /api/docs/:id/changes` upserts rows inside a GET reachable by viewers/keys; `rerun` scopes by `orgId` the GET deliberately doesn't (`changes/[changeId]/rerun/route.ts:115-119`).
- Link PATCH/DELETE/password routes load the entire link list to check one id (`links/[linkId]/route.ts:321-324`); use `exists()`.
- 13 routes hand-roll the doc tenancy filter instead of `buildDocMatch` (SECURITY.md §7 #1 pattern).

### Billing / identity
- Personal-org bootstrap races throw E11000 instead of re-reading (`src/lib/models/Org.ts:128-170`).
- Free team-workspace cap is check-then-create (`src/app/api/orgs/route.ts:266-302`).
- Stripe customer creation not idempotent and ignores `isDeleted` (`src/lib/billing/workspaceCustomer.ts:27, 50-54`).
- Downgrade from Pro never restores `dailyCreditCap` (`src/lib/credits/grants.ts:151`, webhook `deleted` handler); legacy payg still flips on-demand on.
- N+1 membership counts in deletion planning (`purge.ts:149-152`, `account/delete/route.ts:66-74`).

### Projects / notifications
- `Project.docCount` hook is read-then-diff; concurrent updates drift (`src/lib/models/Doc.ts:403-440`).
- Duplicate `$or` keys in three backfill filters silently drop the tenancy clause (`projects/route.ts:206-222`, `[projectSlug]/docs/route.ts:134-148, 197-211`); harmless today, exact catalogued bug shape.
- `shareviews/visits` anonymous lookup degrades to match-all prefix regex on non-hex `botIdHash` (`[projectSlug]/shareviews/visits/route.ts:58-60, 83-86`).
- `GET /api/tags/:tag/docs` pages on non-unique sort key (`tags/[tag]/docs/route.ts:259-265`).
- `GET /api/tags` loads every assignment and referenced id per call (`src/lib/tags/service.ts:105-116, 186-228`).
- Off-page and sender disagree on missing `viewEmailMode` (`notifications/views/off/route.ts:143-145` vs `viewNotifications.ts:275-277`).
- Deleting a request repo without a mode leaves dangling `receivedViaRequestProjectId` (`[projectSlug]/route.ts:513, 633-657`).
- Creating a project whose name matches a soft-deleted one returns 409 for an invisible project (`Project.ts:107-110`); partial unique index.
- Nine routes return raw exception text (`shareviews/visits`, `visit-briefs`, `projects`, `[projectSlug]`, `docs`, `suggested-docs`, `starred`, `tags`).
- `GET /api/projects/:id/docs` hands `request.uploadPath` (a bearer) to `viewer` seats (`[projectSlug]/docs/route.ts:184-217, 249-257, 396`).

### Admin / cron
- `reconcileShareLinkCounters` can overwrite a concurrent ingest increment (`reconcileLinkCounters.ts:81-91, 156-162`); compare-and-set.
- Plain support cards seed credit balances as a lookup side effect (`src/lib/support/plain/cards.ts:225`).
- `GET /api/admin/data/requests` runs an unbounded `updateMany` backfill on every list (`admin/data/requests/route.ts:73-79`).
- Debug routes gate on `NODE_ENV` only and bypass `requireAdmin` (`api/debug/route.ts:37`, `debug/cookie/route.ts:52`).
- `/api/admin/deletions` does one count per row (`admin/deletions/route.ts:49-53`).
- `account-purge?userId=` misses accounts beyond the first 1000 due (`cron/account-purge/route.ts:59-63`).

### MCP / AI
- Idempotency cache scoped per org not per key, process-wide 1000 cap (`mcp/src/idempotency.ts:63-65, 151-157`).
- `docChangeDiff` strict `.max()` limits reject whole compares the model produced (`src/lib/ai/docChangeDiff.ts:33-73, 436-466`).
- `requestReviewInvestorFocused` parses free text with `.strict()` (`:26-38, 212-213`).
- AI run recorder persists full prompts (customer PDF text) with no TTL (`src/lib/ai/aiRunRecorder.ts:55-79`, `AiRun.ts`).
- `lnkdrp_get_share` reads the link list twice (`mcp/src/tools/getShare.ts:67, 81`).
- `lnkdrp_list_docs { tag }` fans out all chunks in parallel; slug resolution scans up to 50 pages (`discover.ts:206-214`, `projects.ts:182-194`).

### Infra / tests
- No `select: false` on any password/hash field (`ShareLink.ts:77-81`, `Doc.ts:209-215`, `User.ts:18`); safety depends on every read site projecting.
- Preflight Mongo URI check false-fails on multi-host strings (`src/lib/preflight/env.ts:168-175`).
- Mongo-backed tests silently skip: vitest `envDir: "./tmp"` does not exist, so `canRun()` is always false.
- `tests:agent:vitest` is a live-model eval wired beside the unit suites.

### Frontend
- `realtime.ts` leaks its 15 s watchdog interval on every `disconnect()` (`src/lib/client/realtime.ts:182-263`).
- A failed background refresh replaces every metrics figure with the error string (`MetricsView.tsx:1366-1368, 1426-1429`).
- Optimistic star/reorder never rolled back on server refusal (`src/lib/starredDocs.ts:255-268, 356-369`).
- Also noted: review page polls full doc incl. `extractedText` every 1.5 s; sidebar archive failure never reverts; activity feed page-1 tick can prepend into page 2; search fires `/api/docs` per keystroke in Projects scope; QuickStats error state sticky; ~900 lines of unreachable viewer-drawer code in `MetricsView.tsx:2066-2380, 3620-4282` plus orphaned `DocMetricsModal.tsx`; dead `src/app/project/[projectSlug]/pageClient.tsx`; credits confirmation polls every 5 s with no ceiling; `/preferences` is a stale parallel copy of the dashboard; `providers.tsx:489-530` fetches `/api/orgs/active` on every client navigation.

---

## What looks solid

- **Tenancy**: `buildDocMatch`/`buildUploadMatch`/`liveProjectByIdMatch` bind org in the query on every write path traced; `currentUploadId`, `blobUrl`, `previewImageUrl` are non-patchable; `viewer` role refused on every mutating route.
- **Public share gating**: link → refusal → password → membership ordering holds on every data-room route; `shareLinkUnlocked` is unconditional on stats, preview, download-requests; cookie HMAC includes the stored hash so rotation revokes; unlock has bucketed rate limits with failure penalty.
- **Blob byte-serving**: every dereference goes through `fetchStoredBlob` (host allowlist per hop, one redirect), PDFs pinned to `application/pdf`, previews pinned by magic bytes with 8 MB cap.
- **Money**: webhook raw-body signature verification, insert-before-process idempotency, credit-pack grants idempotent per Checkout session with server-side amount check; ledger reserve/commit/refund in transactions with `(workspaceId, idempotencyKey)` unique; `forbidApiKey` + `requireOrgRole` + `forbidWaitlisted` on every route that takes money.
- **Admin/cron**: all 47 admin handlers call `requireAdmin`; cron secrets constant-time and fail-closed; `CronHealth` lease is atomic with token-scoped release.
- **MCP/realtime**: sessions bound to `sha256(key)` with `timingSafeEqual`; untrusted content wrapping applied consistently on read tools; HKDF-derived ticket key, per-org socket cap, 4 KB `maxPayload`, backpressure terminate, projected change streams.
- **Crypto**: scrypt + `timingSafeEqual` with length guard, AES-256-GCM random IV, rejection-sampled base62, DNS-pinned `safeFetchUrl` with IPv4-mapped/NAT64/CGNAT ranges.
- **Frontend**: no raw HTML from user content, react-markdown 10 default `urlTransform`, `/a/*` gated server-side, `PdfJsViewer` lifecycle teardown is careful, request sequencing/AbortController in search, tags, links, viewer profile.

## Suggested order of work

1. H1 (upload secret), H4 (MCP body guard), M20 (tokens in change stream) — capability/DoS exposure.
2. H2, H3, M1, M2, M3 — Stripe lifecycle; these cost real money and are support tickets waiting to happen.
3. H10 — webhook tests + CI, before touching the webhook for H3/M2.
4. H5, H6, M5, M6, M7, M10, M11 — data-integrity bugs with clear one-line fixes.
5. H7, H8, H9, M21, M22, M25 — frontend dead-ends users will hit.
6. Everything else as capacity allows; the low list is mostly mechanical.
