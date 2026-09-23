# PRD — Visit briefs (the summary of a visit, after it ends)

**Status:** Approved and built 2026-09-23, M1–M4 complete: reader-page cards with "Write the brief", `recentVisits` on `lnkdrp_get_share_stats`, downloads attributed to the sitting, and the realtime accelerator. Decisions 1–12 locked with the recommended defaults; open questions 1–4 resolved as (a), 2 minutes, 1 credit, Pro-only. See FEATURES.md "Visit briefs". Left: the cron body moving to a queue and worker.
**Owner:** chrissanz
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-view-notifications](./lnkdrp-view-notifications.md) · [lnkdrp-notification-queue](./lnkdrp-notification-queue.md) · [lnkdrp-credit-features](./lnkdrp-credit-features.md) (M1, "follow-up brief per viewer") · [CRON](../CRON.md) · [METRICS](../METRICS.md)

---

## Problem

The "someone opened your document" email goes out the moment a `ShareView` row is created. At
that instant the reader has seen one page for fifteen seconds, so the email can only say *that*
they opened it. Everything the owner actually wants — how long they stayed, which pages held them,
whether they skipped the financials, whether this is the third time back — exists in `ShareVisit`
by the time they close the tab, and nothing sends it.

The owner can reconstruct it from the reader page, if they go and look. DocSend and Papermark
send the visit breakdown *after* the visit; that is the email people in this category expect.

Nothing in the system knows when a visit is over. The client rotates its visit id after 30 minutes
idle and cuts its clock after 5 minutes without input, but the server only ever sees
`lastEventAt` advance and then stop.

## Goal

A few minutes after a recipient stops reading, the owner gets one short, specific account of that
visit — what they read, for how long, what they skipped, how it compares with their last visit —
in email, on the reader page, in the activity feed and through the MCP. Written by the model from
data only LinkDrop has, and paid for in credits.

## Non-goals (v1)

- Real-time "they just closed it" alerts. The signal is minutes after the fact, by design (below).
- A per-viewer *lifetime* profile ("who is warm"). This is per visit; the ranking panel from
  credit-features M1 can be built on top of the stored briefs later.
- Recipient-facing anything. The brief is for the workspace.
- Push, Slack, SMS. Email plus the surfaces that already exist.

## Proposed decisions (to lock)

1. **The unit is a sitting, not a heartbeat and not a person.** For a document link it is one
   `ShareVisit` (`{shareId, botIdHash, visitIdHash}`). For a project link it is every `ShareVisit`
   that shares the same `{shareId, visitIdHash}` — the client keys the visit id by the project
   slug, so one data-room sitting across five documents is already one visit id. One brief per
   sitting, generated once per workspace, then fanned out to members.

2. **A visit is over when it has been quiet for `VISIT_QUIET_MS` = 2 minutes, decided server-side.**
   Rationale from the tracking code: the client heartbeats every 30 s while the reader is active,
   flushes on `pagehide` when the tab closes, and after 5 minutes without input flushes an `idle`
   chunk and goes silent. Two minutes clears the heartbeat plus the beacon's retry backoff
   (2 s + 6 s + 15 s) with margin. So a closed tab is "over" 2 minutes after the close; a tab left
   open on a page is "over" 7 minutes after the reader stopped touching it (5 min idle cut + 2).
   **Seconds are not achievable** with the current tracking: the server cannot tell "no activity
   for 10 seconds" from "between two heartbeats". Anything under ~45 s would fire mid-read.

3. **Delivery latency is the quiet window plus the cron interval.** The `visit-briefs` cron runs
   every 5 minutes, so a brief lands 2–7 minutes after the tab closes (7–12 if left open). The
   brief's emails are sent in the same tick (the cron calls the queue sender scoped to its own
   kind; the queue's atomic claims make this safe beside the `notification-emails` cron).
   If that proves too slow the accelerator is M4: the realtime server already watches
   `shareviews` change streams and can debounce in memory and poke the cron early, cutting it to
   about a minute. Not a shorter Vercel cron, and never a send in the ingest path.

4. **The schedule is a debounce in the database.** Every stats ingest upserts one `VisitBrief`
   row per sitting with `dueAt = lastEventAt + VISIT_QUIET_MS` (`$max`, so it only moves later).
   When the cron claims a due row it re-reads `lastEventAt`; if the reader came back it pushes
   `dueAt` and releases the row; if still quiet, it generates. Restarts, overlapping runs and
   replayed heartbeats all resolve to one brief per sitting because the row is unique on the
   sitting key. `enqueueNotifications` already accepts `notBefore` for the email leg; nothing
   else new in the queue.

5. **A brief costs 1 credit, Basic tier only, `actionType: "brief"`.** The cost catalog already
   lists "Viewer follow-up briefs" at 1/1/1 as unreleased; this releases it. Reserve before the
   model call, charge on success with provider usage on the ledger row, refund on failure — the
   same three calls the automatic summary uses. It passes the credit test: the owner's agent
   cannot produce it (it does not have the viewing data), it uses LinkDrop's position, and the
   value lands on the sender.

6. **Out of credits degrades to a recap, never to silence.** The email and the stored record
   still go out with the structured facts (pages, times, return count) and an "AI brief skipped:
   out of credits" line with a billing link — the same soft-fail contract as the upload summary
   (`Upload.ai.code = out_of_credits`), and a `credits.exhausted` feed row once per day per
   workspace, not per visit.

7. **Not every visit earns a brief.** Below `BRIEF_MIN_VISIT` (20 s of reading *or* 2 pages seen)
   nothing is generated and no immediate email goes; the visit appears as one line in the daily
   digest. Owner previews (`isOwnerPreview`) never brief. Per-workspace cap of
   `BRIEFS_PER_DAY` = 100 (and the existing Free daily credit brake); beyond it, recap only.
   A visit still active after 6 hours is briefed "so far" so no row waits forever.

8. **Pro only for v1.** The brief narrates per-page time and identity, exactly the analytics the
   Free plan does not show, so a Free brief would be content-free. Free workspaces get one line in
   their existing open email: *Pro sends you a summary of every visit.* (Diverges from
   credit-features' "credit-gated on every plan" rule; the gate here is the analytics tier the
   brief describes, not the credit.)

9. **Auto-briefing is a workspace switch, on by default for Pro.** `autoBriefEnabled` beside
   `autoSummaryEnabled` and `autoCompareEnabled` on `WorkspaceCreditBalance`, shown on the AI
   defaults card with the credit cost next to it. Credits are being spent without a click, so
   the off switch is one click and the usage tab attributes the spend.

10. **Email mode is per member, like the other four kinds:** `OrgMembership.briefEmailMode`
    `off | daily | immediate`, default **`immediate`** — the brief *is* the per-visit email this
    category expects, and it is on the member's own workspace's Pro plan. Members who find
    open-email + brief too much turn the open email off; the preferences copy says so
    (open question 1).

11. **The brief is stored, not just sent.** `VisitBrief` keeps the stats snapshot, the model
    output, the ledger id and status, so the reader page shows every visit's brief, the activity
    feed carries a `share.visit_briefed` row (which the realtime server broadcasts for free), and
    the MCP exposes it — MCP parity is a locked rule for credit features.

12. **Viewer-supplied strings are data in the prompt.** Name, email and link label go into the
    prompt as quoted JSON fields, capped in length, with the system prompt saying they are data.
    Output is a fixed Zod schema (`generateObject`), so a viewer named "ignore prior instructions"
    can at worst get a strange headline, never a different email. The stored brief is wrapped
    `{ _source, _note, text }` on the MCP like every other viewer-derived field.

## Approach

### Data model

`VisitBrief` (new collection `visitbriefs`), one row per sitting:

```ts
{
  orgId, docId | null, projectId | null, shareLinkId,
  shareId,                 // link slug (document or project)
  visitIdHash, botIdHash,  // botIdHash is the PERSON (bare digest; splitProjectViewerKey)
  viewerUserId?, viewerName?, viewerEmail?,
  startedAt, lastEventAt,  // copied at claim time
  dueAt: Date,             // lastEventAt + VISIT_QUIET_MS, $max on every ingest
  status: "scheduled" | "generating" | "briefed" | "recap" | "skipped" | "failed",
  skippedReason?: "owner_preview" | "below_minimum" | "plan" | "auto_off" | "daily_cap",
  claimedAt?, claimToken?, attempts,
  stats: { timeSpentMs, pagesSeen, pageCount, pageTimeMsByPage, pageVisitCountByPage,
           downloads, docsOpened?[], visitNumber, previous?: { startedAt, timeSpentMs, topPages } },
  brief?: { headline, body, highlights[], followUp?, model, tokensIn, tokensOut },
  ledgerId?, aiRunId?,
}
```

Indexes: unique `{shareId, visitIdHash}`; `{status, dueAt}` (the claim); `{orgId, docId, botIdHash, startedAt}`
and `{orgId, projectId, botIdHash, startedAt}` (reader page); `{status, claimedAt}` (stale recovery).

Membership: `briefEmailMode`. Balance: `autoBriefEnabled`. Ledger `actionType` gains `"brief"`,
`creditsForRun` gains the row, `AiRunKind` gains `visitBrief`. Queue kind gains `"visit_briefs"`.

### The ingest hook

`POST /api/share/:shareId/stats`, inside the existing `after()`, one more upsert after the
`ShareVisit` write: `VisitBrief.updateOne({shareId, visitIdHash}, {$setOnInsert: {...keys,
startedAt, status: "scheduled", attempts: 0}, $max: {dueAt, lastEventAt}}, {upsert: true})`.
Best-effort, `void`, never fails the read. Owner previews still get a row so that the same visit
opened signed-out later cannot become a brief; they are skipped at claim.

### The cron

`GET|POST /api/cron/visit-briefs`, `*/5 * * * *`, `runtime nodejs`, `maxDuration 300`, leased,
`CronHealth` heartbeat, `--dry-run` supported (claims nothing). Per tick:

1. `recoverStaleClaims` (generating + claimedAt older than 10 min → scheduled).
2. Claim due rows atomically (`status: scheduled, dueAt ≤ now`), oldest first, batch of 50.
3. Re-read the sitting's `ShareVisit` rows. Not quiet → `$max dueAt`, release. Quiet → build the
   stats snapshot (per-page times, revisits, `pageEvents` order, downloads in the window from
   `ShareView.downloadsByDay`, previous visits by the same `botIdHash` for the return context).
4. Gates in order: owner preview → below minimum → workspace not Pro → auto off → daily cap.
   Each is a terminal `skipped`/`recap` status with the reason; recap still emails.
5. Reserve 1 credit (`idempotencyKey: brief:<visitBriefId>`), call the model, charge with usage,
   store the brief, `recordActivity("share.visit_briefed")`. Model failure → refund, `attempts += 1`,
   backoff, `failed` after 3 with the recap still sent.
6. `enqueueNotifications` kind `visit_briefs`, one row per non-deleted member, dedupe
   `visit_briefs:<userId>:<visitBriefId>`, then `sendNotificationEmails({kind: "visit_briefs"})`
   so the mail leaves in this tick. Time budget: stop claiming at 240 s like the emails cron.

### The model call

`generateObject` with `openai("gpt-4o")` (as built; mini could not read the page text into substance), `OPENAI_PROVIDER_OPTIONS` (store: false),
temperature 0, prompt in `src/lib/prompts/visitBrief.md`. Input is a JSON document: the link
(label, audience), the document (title, page count, per-page outline), the sitting (ordered
page events with durations, revisit counts, total time, downloads, device-free), the return
context (visit number, last visit's top pages and time), and the identity fields as data.
Output schema: `headline` (≤ 12 words, the subject line), `body` (≤ 80 words), `highlights`
(≤ 4 short facts), `followUp` (one optional suggested next step). Recorded through
`aiRunRecorder` like every other run.

**Per-page outline.** Today `Doc.extractedText` is one string with no page boundaries, so the
model could only say "page 7". `src/lib/history/changedPages.ts` already extracts text per page
with pdfjs for the compare feature; the upload processor uses it once per version to store
`Doc.pageOutline: [{page, heading, excerpt}]` (first line plus ~40 words per page, capped at 200
pages). Then the brief says "two and a half minutes on the pricing page (p. 7)". Existing
documents get the outline lazily the first time a brief needs it.

### The email

Subject is the brief's headline when Pro and briefed (`Sequoia read the deck for 6 minutes,
mostly pricing`), else the recap form (`Someone on the Sequoia link read "USAVX MEMO" · 6 min`).
Body: who / link / when / how long, then the brief paragraph and highlights, then a compact
per-page table (top 5 pages by time, "skipped: 9–12"), then the return line ("3rd visit; last
time 2 min on p. 4–6"). One action: **See the whole visit →** to the reader page. Footer, off
link (`EMAIL_OFF_KINDS` gains `briefs`), `List-Unsubscribe` headers, workspace name — all
through the existing shell, catalog id `visit_brief.immediate|daily`, copy in `catalogCopy.ts`
under a new `briefs` setting. Daily mode: one "Today's visits" digest per member with one block
per sitting, at the end-of-day UTC tick, same grouping code path as the other kinds.

### Surfaces

- **Reader page / viewer profile:** a "Visits" list, one card per sitting with the brief or
  recap, and a "Write the brief" button for recap rows (1 credit, POST
  `/api/visits/:visitBriefId/brief`, the same 402 codes and out-of-credits modal as today).
- **Activity feed:** `share.visit_briefed` with `meta.headline`; realtime broadcasts it already.
- **MCP:** `lnkdrp_get_share_stats` gains `recentVisits[]` with the brief; `lnkdrp_get_activity`
  carries the feed row; no new tool in v1. Brief text wrapped as untrusted content.
- **Dashboard:** AI defaults card gains the auto-brief switch and cost; Usage tab attributes
  `brief` runs; `/pricing` and `lnkdrp_whoami.costs` show the released row.
- **Admin:** Emails page counts the new kind; cron board gets the job with `what`/`why`.

### Legal copy

Privacy "How we use information" gains one sentence: viewing activity may be summarised by
automated processing for the person who shared the link; Privacy §5 (written for viewers) gains
the same in viewer terms. Dated note as in Terms §8; the legal-copy pin test extended. Ships in
M3 with the email, before the first send.

## Verification

1. Open a link as a signed-out recipient, read three pages for a minute, close the tab → one
   `VisitBrief` row, `briefed` within 7 minutes, one email to each `immediate` member, one credit
   charged with usage on the ledger, one `share.visit_briefed` feed row.
2. Same, but keep reading after the quiet window would have fired → no brief until the read
   ends; `dueAt` moved; exactly one brief at the end.
3. Open, glance for 5 seconds, close → no brief, no credit, no immediate email; one digest line.
4. Owner opens their own link signed in → row skipped `owner_preview`, no credit.
5. Project link, three documents in one tab → one brief covering all three, `docsOpened` listed.
6. Workspace at 0 credits → recap email with the skip line, `credits.exhausted` once that day,
   the reader page offers "Write the brief".
7. Free workspace → nothing generated, the open email carries the Pro line.
8. Kill `OPENAI_API_KEY` → refund, retry with backoff, recap sent after the third failure.
9. Two cron ticks overlap → lease skips the second; a crashed `generating` row is reclaimed
   after 10 minutes and produces one brief, not two.
10. `tests/share/traffic.ts --readers 6` with pacing → six briefs whose page facts match the
    script's reading pattern; console transport prints six emails.
11. `tests/lib/cronMap.test.ts` passes with the new job.

## Milestones

**M1 — Visit close detection (no model, no email, no credits).** `VisitBrief` model, ingest
upsert, cron with claim/re-check/release, stats snapshot, `share.visit_ended` feed row, project
sitting grouping, unit tests for the debounce. Proves 2, 4, 5, 9 with `status: recap`.

**M2 — The brief.** `actionType brief`, cost row released, reserve/charge/refund, the prompt,
`pageOutline` extraction, `aiRunRecorder` kind, auto-brief switch, soft-fail states. Proves 1
(minus email), 3, 6, 7, 8.

**M3 — The email.** Queue kind, membership mode, preferences row, catalog and copy, template,
off link, legal copy, digest grouping, admin counts. Proves 1, 10, 11.

**M4 — Surfaces and speed.** Reader page cards and the manual "Write the brief" button, MCP
fields, pricing and whoami rows. Optional: the realtime accelerator (debounce on the
`shareviews` stream, poke the cron with the cron secret) if 2–7 minutes proves too slow.

## Open questions

1. **Two emails per first visit.** An `immediate` member gets the open email at the first page
   and the brief 2–7 minutes after the close. Options: (a) keep both, tell people in Preferences
   (recommended — they answer different questions and the open email is already locked
   on-by-default); (b) when brief mode is `immediate`, hold the open email and drop it if the
   brief arrives within 10 minutes (one email, but the "while it is on their screen" moment is
   lost); (c) default brief to `daily`. Recommendation: (a).
2. **Quiet window.** 2 minutes is the proposal. 5 minutes would match the client's idle cut and
   reduce false "over" calls on a slow reader who stares at one page, at the cost of latency.
3. **Cost of the manual "Write the brief" on a recap row.** 1 credit like the auto run, or free
   once per visit because the auto run was already refused? Recommendation: 1 credit.
4. **Free plan.** Pro-only (decision 8), or allow a brief without identity ("a reader spent 6
   minutes, mostly on p. 7") as the upsell? The per-page detail is itself Pro-gated on the
   metrics page, so it would leak through email. Recommendation: Pro-only.
5. **Should the brief also go to a per-link "always instant" override later?** Listed under
   Future in the view-notifications PRD; this feature makes it more valuable.

## Future

- "Who is warm": rank viewers from stored briefs and stats (credit-features M1's panel).
- Weekly roll-up of briefs per document for `off` members.
- A brief on the recipient side when a data room is shared with a team (never in v1).
