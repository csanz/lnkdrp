# Share viewer pre-production review — 2026-09-20

**Scope:** the public, unauthenticated viewer — `/s/[shareId]`, `/p/[shareId]`, their PDF, changes
and og.png routes, the public APIs (`stats`, `unlock`, `landing`, `download-requests`), and
`src/lib/share/*`. Roughly 7,300 lines.

**Method:** eight independent lenses (refusal matrix, password gate, PDF delivery, analytics ingest,
viewer privacy, project links, viewer client, download requests), every finding then put to one to
three adversarial verifiers whose job was to refute it. 91 agents, 37 candidates, 26 confirmed,
11 refuted.

**Two product decisions taken during this pass:** the viewer profile is scoped per workspace, and
download approval becomes a confirmation page plus a POST.

**Status key:** ✅ fixed · ⬜ open

**Update, same day:** a ten-agent fix pass ran straight after this review (one agent per disjoint
file set), plus follow-up work. All but one finding are fixed. Verified: tsc clean, 1740 lib tests +
167 credits + 38 upload passing, `next build` exit 0.

**Still open — "Request download" inside a data room.** The create route was made to work, but the
three claim routes (`/api/download/[token]`, `/pdf`, `/save`) all gate on `resolveShareLink`, which
cannot see a project slug — so an owner would approve and the requester's claim link would 404.
Half a chain is worse than the current honest failure, so it was left. The fix is one shared
resolver those three routes import that falls back to `resolveProjectLink` + `findProjectDocument`.
Until then the "Request download" button should be hidden inside a data room
(`PdfJsViewer` needs a `downloadRequestsEnabled` prop passed false from `/p/[shareId]/[docId]`).


## Blockers (4)

### ✅ [correctness] A legacy document with no orgId 500s its own public share link instead of serving or refusing it

**Where:** `src/lib/share/links.ts:263`

**What:** `ensureDefaultLink` passes `orgId: doc.orgId ?? undefined` into `ShareLinkModel.create`, but `ShareLink.orgId` is `required: true` (src/lib/models/ShareLink.ts:44). For a document that predates workspaces and carries no `orgId` — the case the rest of the tree explicitly supports (`buildDocMatch`'s `allowLegacyByUserId`, src/lib/docs/docMatch.ts:27-34) and the case `scripts/sharelinks-backfill.ts:95-99` deliberately *skips* and records as a problem — the create throws a ValidationError, the catch at links.ts:292-296 finds nothing to fall back to, and rethrows. `resolveShareLink` therefore throws for that slug. The project-side twin has exactly this fix already: `ensureDefaultProjectLink` adopts an org-less project into its owner's personal workspace with a comment saying the throw 'surfaced on the public /p/:shareId as a 500 for a recipient holding a perfectly good legacy link' (src/lib/share/projectLinks.ts:211-227). The document side was never given that treatment.

**How it fails:** A pre-workspaces document still has `shareId: "abc123"` and no `orgId`, and no ShareLink row (the backfill script skipped it). A recipient opens https://…/s/abc123. `src/app/s/[shareId]/layout.tsx:31` calls `resolveShareLink`, which falls through to `DocModel.findOne({ shareId })` (links.ts:327) and then `ensureDefaultLink` (links.ts:331). The create throws, the catch rethrows, the layout has no try/catch, and the recipient gets the `error.tsx` boundary — 'This document couldn't be displayed' under a 500. Every route below it (`/pdf`, `/changes`, `og.png`, `POST /unlock`, `POST /stats`) throws the same way, so the document is unreachable and the owner has no refusal they can act on: it is neither served nor refused.

**Fix:** Mirror `ensureDefaultProjectLink`: before the create in `ensureDefaultLink`, if `doc.orgId` is falsy and `doc.userId` is set, resolve `ensurePersonalOrgForUserId({ userId: doc.userId })`, write the id back onto the Doc, and use it as the link's `orgId`; if there is no owner either, return null and have `resolveShareLink` treat that as a miss (404) rather than letting the throw escape.


### ✅ [privacy] The viewer replays a stored name and email to every sender's link, not just the one it was given to

**Where:** `src/components/PdfJsViewer.tsx:451`

**What:** `applyViewerProfileToStatsPayload` (src/components/PdfJsViewer.tsx:451-455) reads a single browser-global profile (`SHARE_VIEWER_PROFILE_KEY = "lnkdrp_share_viewer_profile_v1"`, src/lib/share/viewerProfile.ts:14) and attaches `viewerName`/`viewerEmail` to *every* stats POST on *any* share link (call sites 1738, 1823, 1860), including the very first POST of a link belonging to a workspace the recipient has never introduced themselves to. The server stores it unconditionally (src/app/api/share/[shareId]/stats/route.ts:365-366), puts it in the `share.viewed` activity row (601-602) and in the view-notification email payload (662-663). The intent comment in viewerProfile.ts justifies the single key with a same-sender case ("the same sender's data room"), and the modal copy promises "Goes to this document's owner only" (PdfJsViewer.tsx:2572) / "Goes to this room's owner only" (src/app/p/[shareId]/IntroduceYourself.tsx:279) — but the key is global across every workspace, and `botId` is likewise one per browser (src/lib/botId.ts:8).

**How it fails:** Dana opens her lawyer's data room and introduces herself as "Dana Reyes / dana@reyes-family.com". localStorage now holds that pair. Next week an unrelated startup cold-emails her a lnkdrp deck at /s/abc123. She opens it and reads nothing further. On first paint PdfJsViewer posts {botId, pageNumber, viewerEmail: "dana@reyes-family.com", viewerName: "Dana Reyes"} to /api/share/abc123/stats. The startup's ShareView row is created with her name and address, its activity feed says "Dana Reyes (dana@reyes-family.com) viewed your document", and every workspace member gets a view-notification email naming her. She never typed anything into that link, was never asked, and was told her details go to "this document's owner only".

**Fix:** Stop replaying the profile to links it was not given to. Smallest correct change: have the profile record which share slugs (or which owning workspaces) it has actually been volunteered to, and make `applyViewerProfileToStatsPayload` attach it only for those; a first-time link renders the "Introduce yourself" affordance pre-filled from the stored profile but sends nothing until the recipient presses Save. Note that /p/'s front page already behaves this way — LandingBeacon (src/app/p/[shareId]/LandingBeacon.tsx:79-83) sends only botId/visitId, and IntroduceYourself posts only on Save — so this is the document viewer diverging from the data-room page, not a product-wide decision.


### ✅ [privacy] The volunteered name/email a recipient gives one sender is replayed to every other sender's links

**Where:** `src/lib/share/viewerProfile.ts:14`

**What:** `SHARE_VIEWER_PROFILE_KEY` is a single, origin-wide localStorage key with nothing identifying the workspace in it. `applyViewerProfileToStatsPayload` (src/components/PdfJsViewer.tsx:451-455) reads it unconditionally and attaches `viewerEmail`/`viewerName` to every stats POST the viewer makes — the load POST (PdfJsViewer.tsx:1823), every page POST (1860) and every reading-clock flush (1738) — for whatever `shareId` happens to be open. The ingest persists them: `/api/share/[shareId]/stats/route.ts:363-366` writes `viewerEmail`, `viewerName` and `viewerEmailSnapshot` onto that link's `ShareView` row on any POST that carries them, not only on the `introduced` one. The viewer's own copy draws the opposite line: "Goes to this document's owner only" (PdfJsViewer.tsx:2572), "The owner of this document sees who opened it" (2478), while "every lnkdrp link you open knows you" (2553) is presented as the separate, opt-in thing you get by signing in. The header comment in viewerProfile.ts says the shared key is deliberate, but its stated reason is "the same sender's data room" — the code is not scoped to a sender.

**How it fails:** A recipient opens Acme's pitch deck at /s/aaa, clicks "Introduce yourself", types "Dana Ruiz / dana@fund.com" and reads the dialog's promise that it goes to this document's owner only. Two weeks later an unrelated workspace, Beta Corp, sends them /s/bbb. On first paint, before Dana touches anything, the viewer POSTs `{botId, visitId, pageNumber:1, viewerEmail:"dana@fund.com", viewerName:"Dana Ruiz"}` to /api/share/bbb/stats, and the route writes both onto Beta Corp's ShareView row. Beta Corp's owner now has Dana's name and address, plus which pages she read and for how long, from a person who never introduced herself to them. On a phone it is worse: the "Viewing as Dana Ruiz" affordance is `hidden lg:block` (PdfJsViewer.tsx:2071) and only reachable inside the overflow menu, so there is nothing on screen saying she is identified.

**Fix:** Scope the stored profile to the owning workspace. Send an opaque owner key down with the existing brand payload (a hash of `orgId` alongside `ShareWorkspaceBrand`, which today carries only `name`/`avatarUrl`), and key storage on it: `lnkdrp_share_viewer_profile_v1:<ownerKey>`, falling back to per-`shareId` when no key is present. `readShareViewerProfile`/`writeShareViewerProfile` take the key as an argument; `applyViewerProfileToStatsPayload` passes the current page's. Reuse then happens across one sender's deck and data room — the behaviour the comment describes and the dialog promises — and never across senders.


### ✅ [security] Approval happens on an unauthenticated GET — any mail scanner or link prefetcher in the owner's inbox approves (or denies) for them

**Where:** `src/app/api/share/[shareId]/download-requests/[token]/approve/route.ts:58`

**What:** The approve route performs the state change inside the GET handler (the write is at line 90) with no session check and no confirmation step, so merely fetching the URL grants the download. The deny route (deny/route.ts:53) has the same shape, and both URLs sit in the same email body (src/lib/email/templates/downloadRequest.ts:49-50). Next serves HEAD from the exported GET, so a HEAD probe is enough too. This is the exact bug the repo already fixed for invites — see the header comment at src/app/org/join/[token]/page.tsx:9-15, which names "a link preview fetcher" as the cause and moved the act behind an explicit POST.

**How it fails:** A recipient files a request on a link whose owner deliberately set allowDownload=false. The owner's mailbox sits behind Microsoft Defender Safe Links / Proofpoint URL Defense / Mimecast, or any client that prefetches links. The scanner GETs the approve URL: status flips to "approved", a claim link is emailed to the requester, who signs in with that Google address and downloads the PDF and saves a permanent copy into their own workspace (/api/download/:token/save). The owner never clicked anything. The same scanner also fetches the deny URL in the same message, so whichever it reaches first decides the outcome — and when the owner finally clicks their real choice they get "Already handled" (approve/route.ts:97) or "Already approved" (deny/route.ts:68), with no way to correct it. There is no other approval surface: ShareDownloadRequestModel is read nowhere outside these routes and the admin email board, so the emailed link is the whole flow.

**Fix:** Make GET inert and move the mutation to POST, mirroring /org/join/[token]: have GET /approve and GET /deny render a page that states the document, the requester's address and the choice, with a button that POSTs to the same path carrying the token. Keep the existing atomic `{ _id, status: "pending" }` guard on the POST. Requiring the owner's session on that POST would close it further, but the interstitial alone stops every prefetcher.


## Majors (14)

### ✅ [correctness] Every /p/** refusal answers HTTP 200 — the segment layout that makes /s/ answer 404 has no counterpart

**Where:** `src/app/p/[shareId]/page.tsx:110`

**What:** `src/app/s/[shareId]/layout.tsx` exists for one reason, stated in its own header comment: `loading.tsx` puts the page under a Suspense boundary, Next flushes the shell and commits a 200 before the page body runs, so `notFound()` renders the right screen under the wrong status — 'Every revoked, expired, archived and unknown link answered 200 OK, which is wrong for the two readers that only look at the status line: a crawler … and an agent.' The `/p/**` tree has `src/app/p/[shareId]/loading.tsx` and `src/app/p/[shareId]/[docId]/loading.tsx` but no `layout.tsx` at any level under `src/app/p`. So every `notFound()` in that tree — unknown slug, a document link's slug, a deleted project (page.tsx:110), a request repo (page.tsx:132), a non-member docId ([docId]/page.tsx:124) — commits 200 OK, the same fault that was considered worth a dedicated file on the document side.

**How it fails:** An owner deletes a data room, or a request repo's slug (which `GET /api/projects` hands to every workspace member including viewer-role, per the comment at page.tsx:123-125) reaches a crawler. A GET of /p/<slug> returns `200 OK` with the 'This project is no longer shared' body. A search engine indexes the URL as a live page and keeps revisiting it; an agent or uptime check that reads the status line concludes the data room is open. `/s/<slug>` for the identical situation returns 404.

**Fix:** Add `src/app/p/[shareId]/layout.tsx` modelled on `src/app/s/[shareId]/layout.tsx`: `export const dynamic = "force-dynamic"`, resolve the slug with `resolveProjectLink`, and `notFound()` when it is null, `project_gone`, or `project.isRequest` — leaving the page's own checks in place, since the layout is the status and not the authorization.


### ✅ [correctness] A locked document link still ingests analytics and viewer identity from callers who never entered the password

**Where:** `src/app/api/share/[shareId]/stats/route.ts:327`

**What:** POST /api/share/:shareId/stats applies the share-auth cookie check only on the project-link branch (`if (projectTarget && projectLinkPasswordEnabled(...))`). On the document-link branch — where `resolveShareLink` returned a link — no unlock check runs at all, so a caller holding a password-protected `/s/` slug but not its password can write ShareView/ShareVisit rows, set `viewerName`/`viewerEmailSnapshot`, move the link's `lastViewedAt`, bump `viewCount` and trigger the owner's view notification. The comment above the guard states this is a known, deliberate scope limit ("the document ingest has always accepted a view on a locked /s/:shareId ... Flagged in the report instead"), so it is a gap that is still open, not one already fixed.

**How it fails:** Owner puts a password on /s/AbC123 and mails it to one investor. The mail gets forwarded to a third party who has the URL but not the password. That party runs `POST /api/share/AbC123/stats` with `{botId:"x", pageNumber:7, durationMs:120000, pageDurationMs:120000, viewerName:"Jane Doe", viewerEmail:"jane@acme.com", introduced:true}` (bounded only by the 120/min per-IP limiter at line 295). The owner's dashboard and activity feed now show "Jane Doe (jane@acme.com)" reading page 7 for two minutes on a link nobody ever unlocked, and an email notification goes out saying so. Repeat with different botIds to manufacture an audience.

**Fix:** Hoist the guard so it runs on both branches: replace the `projectTarget &&` condition with an unconditional check using the already-exported `shareLinkUnlocked(request, shareId, link)` from src/lib/share/links.ts (it returns true when the link has no password), keeping the same quiet `200 {ok:true}` no-op response so a cookie-less browser sees no console error.


### ✅ [correctness] pageNumber has no upper bound, so pagesSeen and the dashboard's page counter can be driven arbitrarily

**Where:** `src/app/api/share/[shareId]/stats/route.ts:142`

**What:** `asPositiveInt` accepts any integer >= 1 with no ceiling, unlike `parsePageBound` (shareTiming.ts:126), which bounds `toPage`/`numPages` to 1..5000. The value is then `$addToSet`-ed into `ShareView.pagesSeen` (line 709), used to build a `pageTimeMsByPage.<n>` map key (line 740), pushed into `ShareVisit.pagesSeen`/`pageEvents` (lines 835, 853), and — once per distinct value — increments `Doc.numberOfPagesViewed` (line 728), which the dashboard sums into its "Pages viewed" tile (src/app/api/dashboard/stats/route.ts:138). Nothing compares it to the document's real page count. The identical risk was recognised one route over: the landing route bounds `ProjectLinkView.sessions` with `$push`/`$slice` precisely because "a fixed botId could grow one row to the 16MB BSON ceiling, past which every landing write on that link fails".

**How it fails:** A recipient of a 10-page deck runs a loop posting `{"botId":"<their own>","pageNumber":n}` for n = 1..100000 (within the 120/min/IP budget, so ~14 hours unattended). `Doc.numberOfPagesViewed` climbs by 100000 and the owner's dashboard "Pages viewed" tile reads 100k against an 11-page library; the owner overlay's GET aggregate ($setUnion over every row's pagesSeen, lines 219-229) grows with it; and once that single ShareView row passes the 16MB BSON limit every subsequent write to it fails, so the viewer's genuine pages and reading time stop being recorded with no error anywhere the owner can see.

**Fix:** Bound it the way the sibling fields already are — `const pageNumber = parsePageBound((body as {pageNumber?: unknown})?.pageNumber)` — and, where `numPages`/`ShareVisit.pageCount` is known, drop a pageNumber above it rather than storing it.


### ⬜ [correctness] In a data room, "Request download" always fails — the route refuses project slugs

**Where:** `src/app/api/share/[shareId]/download-requests/route.ts:88`

**What:** `PdfJsViewer` renders a "Download PDF" button whenever `shareIdSafe` is set; when `canDownload` is false it opens the "Request download" modal instead (PdfJsViewer.tsx:2217-2240), which POSTs to `/api/share/<shareId>/download-requests` (PdfJsViewer.tsx:2866 and 2920). Inside a data room the `shareId` the viewer is given is the **project link's** slug (/p/[shareId]/[docId]/page.tsx:158). That route resolves only document links — `resolveShareLink(shareId)` at line 88, which returns null for a project slug by design — and answers `404 {"error":"Not found"}` at line 89. `fetchJson` throws on a non-ok response (src/lib/http/fetchJson.ts:55), so the modal sets `downloadRequestError` and shows it. This is the default state of every data room: `ensureDefaultProjectLink` writes `allowDownload: false` (projectLinks.ts:248) and `createProjectLink` defaults it false, so `allowDownload` is off unless the sender turns it on per link.

**How it fails:** Owner shares a project link (downloads off, the default). A recipient opens `/p/<slug>` → a document → clicks "Download PDF" → the modal says downloads are disabled and asks for their email → they type it and press Request → the panel shows a red error reading "Not found". No request row is created, no mail reaches the owner, and the recipient is left believing the product is broken. It fails on every document in every data room, every time.

**Fix:** Either suppress the affordance or support it. Smallest correct fix that keeps the button honest: give `ShareViewerClient`/`PdfJsViewer` a `downloadRequestsEnabled` prop (false from /p/[shareId]/[docId]/page.tsx) so the button is hidden when downloads are off on a project link. If the flow should work, `download-requests/route.ts` needs the project branch the stats and landing routes already have — `resolveProjectDocument(shareId, docIdFromReferer/body)`, the project-link password check, `link.allowDownload` for the `download_already_enabled` answer, and the doc it resolved for `docId`/`ownerUserId` — plus a decision about what approval means, since flipping `allowDownload` on a project link opens downloads for every document in the room.


### ✅ [correctness] Every PDF page is rasterised at 1x, so the document is soft on every Retina and mobile screen

**Where:** `src/components/PdfJsViewer.tsx:1301`

**What:** `canvas.width = Math.floor(viewport.width)` sizes the backing store in CSS pixels, and the canvas carries no explicit CSS width/height (`className="block max-h-none max-w-none"`, line 3085), so the browser displays it at its intrinsic size — one bitmap pixel per CSS pixel. `fitScale` is derived from `viewportSize.w`, which is `Math.floor(rect.width)` from `getBoundingClientRect()` (line 627), also CSS pixels. `devicePixelRatio` appears nowhere in the file, nowhere under src/app/s or src/app/p, and there is no canvas rule in globals.css. The same omission is in the all-pages path (line 1475) and the grid path (line 1637).

**How it fails:** A recipient opens a share link on an iPhone (DPR 3) or a MacBook (DPR 2). The fit-to-screen scale resolves to, say, 390 CSS px wide; the canvas backing store is 390x505 and the device paints it across 1170x1515 physical pixels. Body text, footnotes and the numbers in a financial table are upscaled 2-3x and render visibly soft — while the browser's own native PDF viewer, one tap away via Safari's "Open in", renders the same file crisply. For a product whose single job is showing someone a document, the first page they see looks worse than the file they were sent.

**Fix:** Multiply the render scale by the device ratio and pin the display size in CSS. In the single-page render: `const dpr = Math.min(window.devicePixelRatio || 1, 2); const viewport = page.getViewport({ scale: Math.max(0.1, fitScale * zoom * dpr), rotation }); canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height); canvas.style.width = `${Math.floor(viewport.width / dpr)}px`; canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;` — capping at 2 keeps memory sane on 3x phones. Apply the same three lines in the all-pages (1475) and grid (1637) render paths, and add `dpr` to the cache `key` strings at 1454/1617 so a window dragged to another display re-renders.


### ✅ [performance] "All pages" and "Grid" mount a canvas per page and never release a painted one, so a long PDF exhausts the tab

**Where:** `src/components/PdfJsViewer.tsx:3091`

**What:** All-pages mode renders `Array.from({ length: numPages })` canvases at once (line 3091), and grid mode does the same (line 3133). Painted pages are never released: `renderPage` sets `canvas.width`/`canvas.height` to the full page size (1475-1476) and records the page in `allRenderedKeyRef` (1489), which is both the render cache and the only bookkeeping there is. Nothing ever resets a canvas to 0x0 or evicts a key for a page that has scrolled out of view — the cleanup at 1499-1510 cancels in-flight render *tasks* only, and the canvas ref callback (3103-3111) deletes map entries only when the element unmounts, which does not happen while the mode stays on. `gridRenderedKeyRef` (1648) has the same shape.

**How it fails:** A recipient opens a 150-page data-room PDF and switches to "All pages" to skim it. The all-pages column is `max-w-5xl`, so `targetWidth` lands near 1000px and each letter-size page is rasterised at roughly 1000x1290 — about 5 MB of bitmap. Scrolling to the end paints all 150, and every one of those bitmaps is still held: ~750 MB of canvas backing store in one tab. On a phone or a modest laptop the tab is killed, or the browser silently discards backing stores and the reader is left scrolling through blank black cards that never repaint, because `allRenderedKeyRef` still says those pages are rendered and `renderPage` returns early at the `prevKey === key` check (1456).

**Fix:** Evict outside a window around the viewport. The render effect already computes `toRender` from `visiblePages`; widen it to a keep-set (say visible ±3) and, at the end of the effect body, walk `allCanvasesRef` and for every page not in the keep-set do `canvas.width = 0; canvas.height = 0; allRenderedKeyRef.current.delete(p);`. That returns the bitmap and lets the page re-render when it scrolls back. Do the same for `gridCanvasesRef`/`gridRenderedKeyRef` in the grid effect.


### ✅ [privacy] A password-protected document link accepts analytics writes from a caller who never entered the password

**Where:** `src/app/api/share/[shareId]/stats/route.ts:327`

**What:** The unlock guard at line 327 is `if (projectTarget && projectLinkPasswordEnabled(link))` — project links only. The code says so and says it was left that way on purpose ('the document ingest has always accepted a view on a locked /s/:shareId … Flagged in the report instead', lines 324-326); I am reporting it because it is still open, not because the comment is missing. Every other path to a protected document link asks: the page (page.tsx:196-209), the PDF proxy (pdf/route.ts:205-212), both `changes` routes, and the download-request chain, whose guard carries the rule in full — 'a protected link answers nothing — not the document, not a request about it, not its download setting — to a caller who has not entered the password' (src/lib/share/links.ts:135-152). The ingest is the one hole left.

**How it fails:** Someone forwards a password-protected /s/<slug>. The new holder never gets the password, but POSTs {botId: <random>, introduced: true, viewerName: 'Jane Doe', viewerEmail: 'jane@investor.com', pageNumber, durationMs} to /api/share/<slug>/stats. A ShareView row is created, `Doc.numberOfViews` is incremented, a `share.viewed` and a `viewer.introduced` activity row land in the owner's feed, and `enqueueNotification` fans a 'someone read this' email out to every workspace member. The owner concludes the password reached its recipient and that a named person read the deck; nobody ever passed the gate. Repeating with fresh botIds fabricates readers and reading time on the one link whose numbers are supposed to mean 'the password worked'.

**Fix:** Lift the existing cookie check above the `projectTarget` branch so it runs whenever the resolved link has password material — the same quiet `200 {ok:true}` with no write that the project branch already returns, so a recipient whose browser refuses the cookie sees a no-op rather than a console error.


### ✅ [privacy] Public Vercel Blob URLs for the document's first page are handed to the viewer and published as og:image

**Where:** `src/app/p/[shareId]/page.tsx:210`

**What:** `doc.previewImageUrl` / `doc.firstPagePngUrl` are public Blob URLs (`src/lib/models/Doc.ts:129`, uploaded with `access:"public"` in `src/lib/client/docUploadPipeline.ts:215,235`). The data-room page renders them directly (`<img src={previewUrl}>`, line 210), as do `src/app/s/[shareId]/page.tsx:253` and `src/app/p/[shareId]/[docId]/page.tsx:188`, and `generateMetadata` publishes the same URL as `og:image` (`src/app/s/[shareId]/page.tsx:124-131`, `src/app/p/[shareId]/[docId]/page.tsx:108-116`). The project's own privacy model classifies exactly these two fields as content that must "never leave the server" (`src/lib/admin/docPrivacy.ts:44-60`). The PDF bytes are correctly proxied and never exposed — the preview is not.

**How it fails:** A recipient opens a data room, copies the thumbnail's image URL out of the page source, and keeps it. The owner later disables the link, sets an expiry, or adds a password; `/p/:shareId` and the PDF proxy all start refusing, but `https://<store>.public.blob.vercel-storage.com/docs/<docId>/uploads/<uploadId>/preview.png` still serves the document's cover page to anyone, forever, with no cookie. On an unprotected link the same URL is in the page's `og:image`, so link-preview bots and anyone who views source have it too.

**Fix:** Serve previews through a same-origin proxy that re-proves the gate, the way the PDF already is — e.g. `/s/:shareId/preview` and `/p/:shareId/:docId/preview` that call `resolveShareLink`/`resolveProjectDocument`, check refusal + the share-auth cookie, then stream the blob — and point the `<img>` tags and `buildShareMetadata` at that path instead of the raw blob URL.


### ✅ [privacy] Share and data-room pages are indexable: no robots.txt, no noindex, and the metadata carries the title, summary and cover

**Where:** `src/lib/share/shareMetadata.ts:58`

**What:** There is no `public/robots.txt` and no `src/app/robots.ts` in the tree, `next.config` sets no `X-Robots-Tag` (only CSP/XFO/nosniff/Referrer-Policy, lines 69-81), and `buildShareMetadata` returns a `Metadata` object with no `robots` field (line 58), so `/s/:shareId` and `/p/:shareId` render as fully indexable pages whose `<title>`, description and `og:image` are the document's real title, its AI summary and its first page (only password-protected and refused links are suppressed).

**How it fails:** A recipient pastes a share link into any crawlable place — a public Slack/Discord archive, a Notion page, a forum post, a Jira ticket on a public tracker. Googlebot follows it, gets 200 with `<title>Acme — Series A deck</title>` and the cover image, and indexes it. Searching the company name then surfaces the confidential deck's share page, and the owner has no signal that it happened.

**Fix:** Add `robots: { index: false, follow: false }` to the object `buildShareMetadata` returns (it is used by every `/s/` and `/p/` page), and add a `public/robots.txt` disallowing `/s/` and `/p/`.


### ✅ [privacy] The download-request response tells any link holder whether a given email address already asked for this document

**Where:** `src/app/api/share/[shareId]/download-requests/route.ts:117`

**What:** The route looks up an existing pending request keyed on `{shareId, requesterEmail}` (lines 109-116) and then answers differently depending on what it found: `kind: "already_requested"` with a `retryAfterSeconds` inside the 60s dedupe window (124-129), `kind: "resent"` when a pending row exists but is older (249), and `kind: "created"` when there is none (249). The pending row has no expiry — it stays `pending` until the owner clicks approve or deny — so the created/resent split is a permanent oracle. The viewer surfaces it verbatim: "Request already sent — A request for this email is already pending" and "Request resent — We resent your request to the owner" versus "Request sent" (src/components/PdfJsViewer.tsx:2799-2814). The requester email is entirely caller-supplied and never proved.

**How it fails:** A deck is sent to several funds on one shared link with downloads off. A recipient at fund A opens the Request-download dialog, types partner@fundB.com instead of their own address, and submits. The dialog answers "Request resent — We resent your request to the owner." Fund A now knows fund B's partner has an outstanding download request on this deck. Typing a colleague at fund C returns "Request sent", so fund C has not. The per-IP and per-email limiters (5/hour each, lines 81-84) slow the probing but do not remove the distinguisher, and each probe also mails the probed address a "we received your request" receipt (line 188) it never asked for.

**Fix:** Make the reply identical whatever was found: return one neutral `kind` (e.g. always "created") plus the "Sent to:" echo, and keep the dedupe/resend decision purely server-side. The `already_requested` and `resent` cases carry no information the requester needs that "Request sent" does not already convey, and the caller cannot be trusted to own the address it typed.


### ✅ [security] Password-guess attempts are bounded per IP only, so rotating source IPs lifts the cap entirely

**Where:** `src/app/api/share/[shareId]/unlock/route.ts:48`

**What:** The unlock limiter key is `unlock:${ip}:${shareId}` and it is the only bound on guesses anywhere in the request path (no middleware, and `grep -rn "unlock:" src/` shows this single key). There is no per-link bucket, so the 10-per-5-minutes ceiling is per source address rather than per link. `clientIpFromRequest` derives the key purely from `x-forwarded-for`/`x-real-ip`, and the limiter also fails open when Mongo is unreachable (src/lib/http/rateLimit.ts:110-113). Since the product deliberately permits 1-128 character passwords (src/lib/share/passwordPolicy.ts:13 and its comment, which cites exactly this limiter as the reason short passwords are safe), the guess budget for a short password is effectively unbounded.

**How it fails:** An attacker holds a forwarded link to a password-protected deck whose sender chose a short password ("jeff", the case the passwordPolicy comment explicitly blesses). They drive `POST /api/share/:shareId/unlock` through a residential-proxy pool or an IPv6 /64: each address gets its own fresh `unlock:<ip>:<shareId>` bucket worth 10 attempts per 5 minutes, and nothing counts the link's total. A few hundred addresses exhaust a 4-lowercase-letter keyspace, the attacker gets the cookie and reads the confidential document.

**Fix:** Add a second, link-scoped bucket alongside the per-IP one in the same handler — e.g. `await rateLimit({ key: `unlock:share:${shareId}`, limit: 100, windowMs: 60*60*1000 })` — and refuse when either is exhausted, so a link's total guess budget is capped no matter how many addresses the attempts come from.


### ✅ [security] The stats ingest writes a view (and emails the workspace) on a password-protected /s/ link without the password

**Where:** `src/app/api/share/[shareId]/stats/route.ts:327`

**What:** `POST /api/share/:shareId/stats` enforces the share-auth cookie only on the project branch (`if (projectTarget && projectLinkPasswordEnabled(...))`, line 327). The document branch — a `/s/:shareId` slug — runs the whole ingest with no gate check, so anyone holding a forwarded protected slug can write a `ShareView` row carrying an attacker-chosen `viewerName`/`viewerEmail`, page numbers and reading time, and a first row (`createdShareViewId`, line 631) fans out a `share_views` notification to every member of the owner's workspace. The comment at lines 324-326 acknowledges this is open and says it was "flagged in the report instead".

**How it fails:** A recipient forwards a password-protected link to a third party who never learns the password. That party POSTs once to `/api/share/<slug>/stats` with `{botId:"<random>", introduced:true, viewerName:"Jane Doe", viewerEmail:"jane@sequoia.com", pageNumber:14, durationMs:600000}`. The row is created, `touchShareLink(shareId,"view",{countView:true})` moves the link's counters and `lastViewedAt`, a `viewer.introduced` activity row is written, and every workspace member gets an email saying Jane Doe read the deck — on a link whose gate was never passed.

**Fix:** Hoist the cookie check above the branch: after `const link = resolved ? resolved.link : projectTarget!.link;`, call the existing `shareLinkUnlocked(request, shareId, link)` helper from `@/lib/share/links` and return the same quiet `{ok:true}` no-op when it is false, for both branches.


### ✅ [security] A password-locked /s/ link accepts forged readings from someone who never unlocked it

**Where:** `src/app/api/share/[shareId]/stats/route.ts:327`

**What:** The password gate on the ingest is guarded by `if (projectTarget && projectLinkPasswordEnabled(...))`, so it only runs on the project-link branch. On the document branch nothing checks the share-auth cookie, and `resolveShareLink`'s `refusal` (links.ts:334-343) covers only archived/disabled/expired/doc_gone — never a password. A caller who has the slug but not the password is refused the PDF but accepted by the ingest, and the row they write is indistinguishable from a real reading. The in-file comment at lines 318-334 says this was noticed and deliberately left for the document branch ("Flagged in the report instead"), so it is a known gap rather than a fixed one.

**How it fails:** A sender forwards https://lnkdrp.com/s/abc123 by email and sends the password separately; the email is forwarded on to someone who was never meant to have it. That person cannot open the document, but `curl -XPOST /api/share/abc123/stats -d '{"botId":"z","introduced":true,"viewerName":"Jane Partner","viewerEmail":"jane@fund.com","pageNumber":7,"durationMs":600000}'` gets a 200. The owner's link row gets `lastViewedAt` and a counted view (line 511), `Doc.numberOfViews` is incremented (line 567), a `share.viewed` and a `viewer.introduced` activity row are written (lines 443, 585), and a "someone opened your document" notification is queued to every workspace member (lines 631-668). The owner is told in email and in the feed that Jane Partner read 7 pages of a document she never unlocked.

**Fix:** Lift the cookie check out of the `projectTarget` branch and run it for the document branch too: when `shareLinkPasswordEnabled(link)` (already exported from src/lib/share/links.ts:114) and `shareLinkUnlocked(request, shareId, link)` (links.ts:158) is false, return the same quiet `{ ok: true }` the project branch returns at line 332 before any write.


### ✅ [security] Deny cannot revoke an approval, so a mistaken (or scanner-triggered) approval is irreversible

**Where:** `src/app/api/share/[shareId]/download-requests/[token]/deny/route.ts:67`

**What:** `if (status === "approved") return htmlPage("Already approved", …)` short-circuits before any write, and there is no other owner-side surface for these rows. Once approved, the claim link is permanent: the three claim routes only require `{ claimTokenHash, status: "approved" }` (api/download/[token]/route.ts:37, pdf/route.ts:59, save/route.ts:36) plus a still-resolvable link.

**How it fails:** The owner fat-fingers Approve in the email (or finding #1's scanner does it). They go straight back to the same mail and click Deny — the page says "Already approved" and nothing changes. The requester keeps a working claim link that re-downloads the PDF indefinitely and can take a permanent copy via /save. The owner's only remaining lever is disabling or archiving the whole share link, which also cuts off every other recipient that link was created for.

**Fix:** In the deny route, let an approved row be denied: drop the early return and run `updateOne({ _id, status: { $in: ["pending", "approved"] } }, { $set: { status: "denied", deniedAt: now }, $unset: { claimTokenHash: "" } })`. The claim routes' `status: "approved"` filter then refuses the outstanding link on the next request, with no other change. Keep the "already denied" short-circuit.


## Minors (8)

### ✅ [correctness] Owner-side password verify does not trim, so it reports "no match" for a string the recipient's unlock route accepts

**Where:** `src/app/api/docs/[docId]/links/[linkId]/password/verify/route.ts:77`

**What:** Every write path trims before hashing (`passwordFields` at src/lib/share/links.ts:605-609, and src/app/api/docs/[docId]/share-password/route.ts:169), and the recipient's unlock route trims the submitted password via `asNonEmptyString` (src/app/api/share/[shareId]/unlock/route.ts:23-27, 39). This verify route passes `body.password` straight to `verifySharePassword` with no trim, so the two paths disagree on padded input — and this route's whole contract, stated in its own header comment, is to answer "will this password let my recipient in?".

**How it fails:** An owner (or an agent via the MCP `lnkdrp_verify_share_password` tool, which fronts this route) checks a password copied from a chat message with a trailing space: " acme2026 ". The link's stored hash is of "acme2026". Verify answers `matches: false`, so the owner concludes the password is wrong and rotates it — cutting off the recipient — even though pasting that exact string into the gate at /s/:shareId would have unlocked it, because the unlock route trims first.

**Fix:** Trim before comparing, matching the unlock route: `const candidate = body.password.trim();` and pass `candidate` to `verifySharePassword` (keeping the existing empty-string rejection at line 41).


### ✅ [correctness] The PDF proxy stores unvalidated forwarding-header text as the viewer's IP

**Where:** `src/app/s/[shareId]/pdf/route.ts:35`

**What:** This route's private `normalizeIp` (lines 35-52) returns the header value as-is for anything that is not a bracketed IPv6 or an `IPv4:port`, with no `net.isIP` check — unlike the two other copies in the codebase, which both validate and document why (`src/lib/http/rateLimit.ts:116-131`: "Returns null for anything that is not an IP literal, so a caller sending arbitrary text in a forwarding header cannot…"; `src/app/api/share/[shareId]/stats/route.ts:87-102`: "proxy headers are client-influenced text"). `getClientIp` (line 58) reads `cf-connecting-ip` and `true-client-ip` first, neither of which the platform sets, and the result is written to `ShareView.viewerIp` at lines 250 and 281.

**How it fails:** Anyone with a download-enabled share slug requests `/s/<slug>/pdf?download=1&botId=x` with `true-client-ip: not-an-ip-at-all`. That literal string is stored as `viewerIp` on the recipient row and is what the owner/admin viewer-detail surfaces then display and search on (`src/app/a/shareviews/page.tsx:386`), and it is what any IP-derived geo feature would be fed.

**Fix:** Delete the local `normalizeIp`/`getClientIp` pair and use `clientIpFromRequest` from `@/lib/http/rateLimit`, which the `/p/` twin already uses (`src/app/p/[shareId]/[docId]/pdf/route.ts:127`).


### ✅ [design] The download proxy is the one public ingest with no rate limit, and each fresh botId inflates the document's view count

**Where:** `src/app/s/[shareId]/pdf/route.ts:265`

**What:** `/s/:shareId/pdf` calls no `rateLimit` at all, while every other public ingest does (`stats` 120/min, `landing` 60/min, `unlock` 10/5min, `download-requests` 5/hour). Each request with a `botId` never seen before upserts a `ShareView` row and, at line 265, `$inc`s `Doc.numberOfViews` — the document-wide figure that spans every link — plus a `share.downloaded` activity row per request (line 300).

**How it fails:** A stranger holding one download-enabled slug loops `GET /s/<slug>/pdf?download=1&botId=<uuid-each-time>` with a Range header of `bytes=0-0`. Every iteration inserts a new `ShareView` row, adds one to the document's `numberOfViews` (which the owner reads on a document shared through several links, not just this one), and writes an activity row — unbounded, unauthenticated, and with no per-IP ceiling to slow it.

**Fix:** Add the same `rateLimit({ key: \`sharepdf:ip:${clientIpFromRequest(request)}\`, … })` guard the stats ingest uses, applied to the tracking block (not to serving the bytes), in both this route and the `/p/` twin.


### ✅ [design] The data room's password gate asks for the password "to view this document"

**Where:** `src/components/PasswordGate.tsx:94`

**What:** Both project routes render `PasswordGate` with `title={null}` (/p/[shareId]/page.tsx:149 and /p/[shareId]/[docId]/page.tsx:144), and with no title the component falls back to the fixed string "Enter the password to view this document." (PasswordGate.tsx:94). On `/p/:shareId` that page is a room of many documents, not a document. `RefusalNotice` went to the trouble of project-specific words for exactly this reason (its header comment) and the gate did not.

**How it fails:** A recipient opens a data-room link sent to them, sees "Password required — Enter the password to view this document.", and reasonably concludes the link is the wrong one, or that the sender sent a single file rather than the eleven-document room they were told about. The gate is also the surface most likely to be mistaken for phishing, which is why the component deliberately names the sending workspace — wording that does not match what the recipient was sent works against that.

**Fix:** Give `PasswordGate` an optional `subject?: "document" | "project"` (default "document") and render "Enter the password to view these documents." when it is "project"; pass `subject="project"` from /p/[shareId]/page.tsx:149. The per-document gate at [docId]/page.tsx:144 can keep the document wording.


### ✅ [design] The fallback banner tells production recipients "pdf.js failed in dev" and offers to retry pdf.js

**Where:** `src/components/PdfJsViewer.tsx:2964`

**What:** The banner is rendered whenever `useNativePdf` is true, with fixed text: "Viewer fallback — Using the browser's native PDF viewer (pdf.js failed in dev)." plus a "Try pdf.js again" button (2973-2982). There is no dev/prod guard on it. `useNativePdf` is set from two places, and only one is the dev-time case the copy describes: the narrow `/defineProperty/i`-or-`/non-?object/i` branch at 1201-1220, and the "Use native viewer" button in the recipient-facing error panel at 3047-3050, which runs in production.

**How it fails:** pdf.js fails to load for a recipient in production — a locked-down corporate browser that blocks module workers, an extension that breaks the dynamic import. They see the error card, click the one button that sounds hopeful ("Use native viewer"), and the document appears under a permanent bar that tells them, in a confidential deal context, that the sender's software "failed in dev" and invites them to "Try pdf.js again". The product looks unfinished at exactly the moment it had recovered.

**Fix:** Split the copy: keep the internal wording behind `process.env.NODE_ENV !== "production"`, and in production say something a recipient can act on — "Showing this document in your browser's built-in PDF viewer." Relabel "Try pdf.js again" to "Switch back", or drop it in production and keep only "Open PDF directly".


### ✅ [design] A resend marks the earlier request "denied", so the owner's first approval email reports a denial nobody made

**Where:** `src/app/api/share/[shareId]/download-requests/route.ts:133`

**What:** When a pending request is older than the 60s dedupe window, the route sets the existing row to `status: "denied", deniedAt` and creates a fresh row with a new token. The old approve link is still in the owner's inbox and now resolves to a denied row, which approve/route.ts:73 renders as "Already denied — This request has already been denied."

**How it fails:** The requester clicks Request, sees nothing happen, waits a minute and clicks again — exactly what the viewer's own copy invites ("Please wait a minute and try again if you need to resend", PdfJsViewer.tsx:2810). The owner now has two identical "Download request" mails. They open the first and click Approve, and the product tells them the request has already been denied. Reading that as "someone already refused this" or "they withdrew it", they close the thread and the genuinely pending second request is never actioned — the recipient waits for an approval that never comes, and the activity feed also carries a denial the owner never performed.

**Fix:** Either reuse the pending row on a resend (re-send the owner mail with the same token, updating ownerEmailSentAt) instead of denying it and minting a new one, or add a distinct `superseded` status that both pages render as "a newer request replaced this one — approve the most recent email instead".


### ✅ [privacy] An expired project link still says which document ids are in the room

**Where:** `src/lib/share/projectPublic.ts:202`

**What:** The comment directly above says 'A refused link still resolves its document: the caller renders the refusal, and it must do so identically whether the document exists or not' (lines 198-199), but line 202 returns `null` when `findProjectDocument` misses. `/p/[shareId]/[docId]/page.tsx` then takes two different branches: `!resolved` → `notFound()` (line 124), which renders `src/app/p/not-found.tsx` ('This project is no longer shared'), while a real member document falls through to `RefusalNotice kind="expired"` ('This link has expired', line 130). For `disabled`/`archived` the two strings coincide, so the invariant only actually breaks on expiry — but it does break there.

**How it fails:** A recipient's data-room link expires. They keep probing /p/<slug>/<docId> with document ids they saw before expiry, or ids from another room in the same workspace: 'This link has expired' means the id is a live, shared, non-archived member of this project; 'This project is no longer shared' means it is not. The expired link, which should answer one thing to everything, becomes a membership oracle over the room's contents.

**Fix:** Return the resolved link with a null/absent `doc` on the refusal branch instead of `null`, and have the two `/p/[shareId]/[docId]` consumers render the refusal before they look at the document — so the refusal branch is reached on exactly the same input regardless of whether the id is a member.


### ✅ [privacy] A locked data room's password gate tells a stranger which documents are in it

**Where:** `src/app/p/[shareId]/[docId]/page.tsx:137`

**What:** `resolveProjectDocument` deliberately returns null (→ `notFound()`) for a document that is not in the project, and the comment at src/lib/share/projectPublic.ts:186-190 states the invariant: "a recipient must not be able to learn that a document id exists somewhere else in the workspace by watching the shape of the answer." But on `/p/:shareId/:docId` the membership resolve happens at line 123-124, before the password check at line 137-144, so the two outcomes are distinguishable without the password: an in-project `docId` renders the `PasswordGate`, a non-member `docId` 404s. `[docId]/pdf/route.ts` has the same ordering (resolve at 130, 404 at 134, password at 144-148), and additionally separates "member with a PDF" (401) from "member without one" (404 "PDF not available").

**How it fails:** A recipient of an unlocked data room A reads the docIds straight out of the page's card links (`/p/<slugA>/<docId>`). Given the slug of password-protected data room B from the same workspace, they request `/p/<slugB>/<docId>` for each one: a password prompt means that document is in B, a 404 means it is not. They learn B's contents list — which documents the sender put in front of that audience — without ever having the password, which is the fact the gate at page.tsx:146-148 refuses to disclose ("not the project's name, not how many documents are in it").

**Fix:** Check the password before the document. Resolve the link first (`resolveProjectLink`), render the gate on a cookie miss, and only then call `findProjectDocument` — so a locked link answers identically for every `docId`. Same reordering in `[docId]/pdf/route.ts`: move the cookie check above the membership resolve and the `blobUrl` check.

