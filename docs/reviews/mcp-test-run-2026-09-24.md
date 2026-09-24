# MCP test run — 2026-09-24

A live run of every MCP harness against the local stack (app `:3001`, MCP `:8787`, realtime `:8788`, dev database `lnkdrp_dev_csanz`), followed by simulated recipient traffic on a real deck and the crons that turn that traffic into emails and briefs. What ran, what it found, what was fixed, and what could not be exercised on this workspace.

The workspace used throughout is the dev account's personal workspace, renamed "LNKDRP" (`6ab46f3add6983534677931d`), which is on **Free** in this database (its subscription row is `status: free`). That one fact explains every "withheld" and "skipped" below.

## Harness results

| Harness | Result | Notes |
|---|---|---|
| `tests/mcp/e2e.ts --fast` | **50 of 50 steps passed** (run 4) | Runs 1 to 3 failed for three different reasons, all fixed or explained below. |
| `tests/mcp/freeplan.ts` | **20 of 20 checks passed** | Whoami on Free, the Pro-only gate refusing up front, the document cap reached and released by archiving, clamped anonymous analytics. Cleaned up its 10 probe documents. |
| `tests/mcp/analytics.ts --docId …` | consistent | Per-link figures add up to the document's (8 views, 10 opens, 2 returns, 705 s); tier `basic`, identities withheld, `recentVisits` absent, as documented for Free. |
| `tests/share/traffic.ts` (8 readers, then 5) | 13 readers, 16 visits | Page flips up to 5 of 12 pages, two returning readers, five introductions, zero downloads (no reader was planned to download). |

### Why the first three e2e runs failed

1. **`owner_removed` at initialize.** The harness's default workspace and user (`6ab2d81f…`) do not exist in this database at all; the default was set against a different dev database. Run with `E2E_ORG_ID` / `E2E_USER_ID` for the workspace above. Worth changing the default or making the harness pick the dev account's personal workspace the way `freeplan.ts` does.
2. **`plan_limit` on `allowRevisionHistory`.** The step assumed turning recipient version history on is merely ineffective on Free; since the plan gates shipped the write itself is refused (`version_history`). Fixed in the harness: that refusal is now the Free branch and only the off-case is asserted. The five project-link steps are likewise Pro-only (`project_links`) and are now skipped as a block when `capabilities.projectLinks.available` is false, instead of failing at the first one.
3. **HTTP 500 from `GET /s/<shareId>`.** Transient: the same URL answered 200 on three direct probes a minute later and the step passed on the next run. The dev server was recompiling while another agent edited files; there was no `ErrorEvent` row. Do not chase it unless it recurs on a quiet server.

## Recipient simulation, end to end

- **Deck.** `tmp/share-deck.ts` rendered the seed corpus's "Northwind Robotics — Series A deck" (12 pages) and shared it through `lnkdrp_share_pdf { filePath, waitForReady }`. The AI summary ran on upload: one basic-tier credit, a four-sentence summary from 2,738 characters of text. `keyPoints` is empty and `oneLiner` unset at the basic tier; check whether that is intended.
- **Reading.** `tests/share/traffic.ts` drove the public ingest with the viewer's exact payload shapes: load, page turns with both clocks flushed, close, a second sitting in a new tab for returners.
- **Introductions.** The simulator sent names on the load heartbeat, which the ingest stores on the row but does not treat as the act of introducing; no `viewer.introduced` row and no owner email resulted from three named readers. The real viewer sends a separate post with `introduced: true`. The simulator now does the same on a reader's first sitting, and the next run produced three `viewer.introduced` rows and their fan-out.
- **View emails.** `cron:notification-emails` sent one immediate email covering 8 events, then one covering 6 (`EMAIL_TRANSPORT=console`, so the bodies print on the dev server's console). On Free the email says "Someone opened …" with no name, and now carries the "See who opened it" button from Phase 1.7.
- **Visit briefs ("summaries at the end").** Every sitting got a `VisitBrief` row with `dueAt = last event + 2 min`. `cron:visit-briefs` claimed them once due and **skipped every one**: `below_minimum` for the two bounces (under 20 s and 2 pages), `plan` for the rest. Briefs are Pro-only (decision 8 in the visit-briefs PRD); on Free the row is a recap with no email. The Pro path (a brief written by the model, one credit, an email with the headline) was **not exercised** because no Pro workspace exists in this database.

## The reader-page link question

"When someone views, their name (or Someone) used to link to the reader metrics page; it no longer does." Verified against `src/app/api/activity/route.ts`: `readerHref` is only built when `showViewerIdentity`, which is `plan === "pro"`. That gate is from commit `e3daa8b` (2026-09-13) and the link itself from `98501e6` (2026-09-19); nothing in this session touched it. It linked before because the workspace was Pro in the previous dev database; here it is Free, so the row says "Someone" and, by the same gate, has no link to a page that would identify them. Not a regression.

## To exercise the Pro paths

Everything withheld above (viewer names and reader links in the feed and emails, `recentVisits`, visit briefs, second project links, recipient version history) needs the workspace on Pro. Stripe is in test mode locally (`sk_test`, `whsec_` set), so the supported route is Upgrade on `/pricing` with the `4242` test card while `stripe listen --forward-to localhost:3001/api/stripe/webhook` is running; that also exercises the Phase 0 checkout and webhook changes. The fallback for a dev database is to set the subscription row to `active` / `kind: pro` and grant the cycle credits with a one-off script.

## Second pass: Pro, and real browser visitors

Stripe test mode showed why the workspace was Free: five Checkout sessions opened today, all `open` / `unpaid`, none completed, and the account's only webhook endpoint is production (`www.lnkdrp.com`), so a local checkout could never land without the Stripe CLI forwarding events (not installed here). `tmp/set-plan-dev.ts` (dev database only, `--revert` to undo) put the workspace on Pro with a synthetic subscription id and a 500-credit cycle grant.

Then three **real** visitors: headless Chrome (`tmp/visit-browser.mjs`, Playwright driving the installed Chrome) opened the share link, turned pages with the viewer's own "Next page" control, and two of them introduced themselves through the viewer's own form. The viewer's real client code posted every heartbeat (10, 17 and 5 stats POSTs, all 200, no console errors, no failed requests).

| Visitor | Pages | Sitting | Outcome |
|---|---|---|---|
| Ada Lovelace (introduced) | 5 of 12 | 29 s | brief: "spent 11 s on the $21.7B market size and timing", two interests |
| Grace Hopper (introduced) | 8 of 12 | 36 s | brief: "spent 9 sec on why we win deals" |
| anonymous | 3 of 12 | 14 s | brief: "spent 7 seconds on the warehouse automation solution" |

- `viewer.introduced` rows appeared for both named visitors, from the real form.
- `cron:visit-briefs` claimed each sitting two minutes after its last event and wrote a brief (one credit each, `creditsCharged` in the cron result); `share.visit_briefed` rows carry the headlines on the feed.
- `lnkdrp_get_share_stats { includeVisits }` on the deep tier returned all three `recentVisits` with headline and interests; the analytics harness listed every reader by name with per-page times.
- The view email for these three went out as one immediate email; on Pro it names the readers.

Everything withheld in the first pass is now exercised except second project links and recipient version history, which the e2e harness skips on purpose rather than exercising.

## Third pass: revisions through the MCP

`tmp/replace-deck.ts` edits the seed spec the way a founder edits slides, renders it, and calls `lnkdrp_replace_pdf { filePath, waitForReady }` on the live deck, then replays the same `idempotencyKey`, then turns recipient version history on with `lnkdrp_update_share_link { allowRevisionHistory: true }`.

| Revision | Edit | Replace | Compare (standard tier, 5 credits) |
|---|---|---|---|
| v2 | customers 335 to 412, market $21.7B to $24.1B, growth 16% to 19%, a use-of-funds bullet added | 27 s to `ready`; replay returned the same upload | 3 changes on pages 4, 5 and 11, each with the exact before and after wording and page images; nothing invented |
| v3 | the "why now" slide cut (12 to 11 pages), chart values changed, the ask $22M to $28M | 33 s; replay idempotent | 7 pages flagged: the ask on page 10, the removed slide reported as sections shifting and a chart removed, image changes on the shifted pages |

- `GET /s/<shareId>/changes` answers 200 with both records once history is on and the workspace is Pro; a real browser visitor sees the **History** control on the share page and reads the new file (the PDF route serves the v3 bytes).
- Activity: `doc.replaced v2`, `share_link.updated`, `doc.replaced v3`. Ledger: one summary credit per version plus five per compare.
- `doc_updates` emails: none queued, correctly, because the workspace has one member and the actor is never emailed about their own replacement. Emails to teammates were not exercised (no second member).
- `timeoutSeconds` on `lnkdrp_replace_pdf` is capped at 120 by the schema; asking for more is a validation error, which the tool reports clearly.

## Fourth pass: revision tools added to the MCP

The MCP could make versions but not read what changed. Three read-only tools now wrap the change records the processing job writes on every replacement, plus a new workspace-wide route behind them:

| Tool | Answers | Route |
|---|---|---|
| `lnkdrp_list_revisions` | what changed, newest first, workspace-wide or one document, in a window (`24h`, `7d`, `30d`, `this_week`, `this_month`, or an ISO date), cursor-paginated | new `GET /api/changes` |
| `lnkdrp_get_revision` | the diff for one version: summary, itemised changes, per-page change kind with previous and new wording and image-changed flags, file sizes and page counts, the compare's own state (done, skipped and why, unchanged), optionally both versions' text | `GET /api/docs/:id/changes?version=N` (new `version` filter) |
| `lnkdrp_revision_contributors` | who made the most changes: per member (replacements, documents, first and last), and per agent client from the activity log | `GET /api/changes?contributors=1` |

Driven against the live deck on a second MCP server (`:8790`, since the one on `:8787` predates the code and needs a restart to pick the tools up): the workspace list showed v2 to v3 then v1 to v2 with who and when; `get_revision` v3 returned the 12-to-11 page change, the ask on page 10 with its wording before and after, and the image flags; v2 with text returned 2,736 and 2,816 characters and the new text contains the new figure; the default version resolves to the current one; a missing version is `not_found` with the current version in the details; contributors named the owner (2 replacements, 1 document) and the two agent clients. The e2e harness gained three steps that assert all of this on the throwaway document (the list includes the replacement and is ordered newest first, the diff has its arrays and compare state, the owner is a contributor).

The `agents` tally reads the activity log and so counts replacements on documents deleted since; `contributors` reads the change records through the workspace's live documents and does not. Both tool descriptions say so.

## Fixes made during the run

- `/connect`: a renamed personal workspace is now named after its real name (`mcpServerName`), the copy says the workspace's name instead of "Personal", and the Copy button sits in its own column instead of floating over the scrolling code.
- `tests/mcp/e2e.ts`: plan-aware on Free (see above).
- `tests/share/traffic.ts`: introductions are a separate `introduced: true` post.

## Open items

- `docs/reviews/mcp-test-coverage-2026-09-21.md` §2 is stale: all 33 tools are in the e2e harness now (`f6bd055`, `5f00a05`). Update or retire the matrix.
- e2e default workspace ids point at a database that no longer exists locally.
- Basic-tier summary leaves `keyPoints` empty and `oneLiner` unset; confirm that is the intended tier shape.
- The Pro paths above remain untested end to end on this database.
