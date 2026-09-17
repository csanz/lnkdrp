# PRD — View notifications

**Status:** Implemented M1–M3 on 2026-09-16. Drafted 2026-09-15; decisions 3, 8 and 9 locked by the owner the same day; the three open questions resolved with the v1 defaults recorded under Open questions.
**Owner:** chrissanz
**Last updated:** 2026-09-17
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-multi-links](./lnkdrp-multi-links.md) · [lnkdrp-plan-limits](./lnkdrp-plan-limits.md) · [lnkdrp-mcp](./lnkdrp-mcp.md) · [METRICS](../METRICS.md)

---

## Problem

lnkdrp records every open of every link, attributes it to the right link, and can tell an
owner who read what for how long. None of that reaches the owner unless they go and look.

- A founder sends the Sequoia link on Tuesday. Sequoia opens it Thursday at 9:40. The founder
  finds out Friday, if they think to open the metrics page, and the moment to follow up — while
  the deck is still on the partner's screen — has passed.
- The product already sends email. Replacement diffs and request-repo uploads go out as
  immediate or daily-digest emails, with per-workspace preferences, an idempotent cursor per
  recipient, and a leased five-minute cron. **Views — the event owners care about most — are the
  one thing that pipeline does not carry.**
- Every competitor in the category treats "someone opened your document" as the core
  notification (DocSend's real-time view alerts, Papermark's per-view emails). Its absence is
  the first thing a user who has used either will notice.

This is a completion of the notification system, not a new one. The cursor model, the
preference shape, the transport and the cron all exist; the job is to add a third event kind
and design the email itself well.

## Goal

An owner learns that a recipient opened their document while it is still useful to know —
immediately for the links that matter, digested for the rest — with enough detail in the email
to decide whether to act, and never so often that they turn it off.

## Non-goals (v1)

- Push, SMS, Slack or in-app notification centre. Email only. The realtime channel already
  updates the open tab; this is for the owner who is not looking.
- Notifying on page turns, time thresholds or downloads as separate events. One event kind:
  a link was opened. Downloads already produce their own activity and can follow later.
- Per-link notification settings in the UI. The preference is per workspace member, like the
  two existing ones. A per-link "always notify me about this one" is listed under Future.
- Recipient-side email (e.g. "your link was viewed by the sender"). Nothing goes to recipients.
- A general unsubscribe centre across all email kinds. The one-click off link in decision 8 is
  scoped to view emails only; extending it to the two existing kinds is a follow-up.

## Proposed decisions (to lock)

1. **Trigger is a new recipient viewer, not every heartbeat.** The email fires when a
   `ShareView` row is *created* for a recipient — the same moment `share.viewed` lands in the
   activity feed — never on the page-turn and dwell heartbeats that follow. A returning reader
   (new `ShareVisit`, existing `ShareView`) is a **return**, and returns are notified only in
   the digest, never immediately. This is what stops one curious investor generating ten emails.

2. **Owner and teammate opens never notify.** Rows flagged `isOwnerPreview` are excluded by
   `RECIPIENT_ONLY_MATCH`, exactly as they are from every count. An owner checking their own
   link must not receive an email about it. The flag is best-effort (needs a signed-in opener),
   so a signed-out owner testing a link *will* get an email — the email copy says how to read
   that (see Email design, "first-view honesty").

3. **Three modes, matching the two existing preferences:** `off` · `daily` · `immediate`.
   **On by default — decided by the owner 2026-09-15.** The concern that immediate-by-default
   becomes the email people filter to spam is answered by decision 1 (one email per new
   recipient, never per heartbeat) and decision 7 (batched per tick), not by defaulting to a
   quieter mode. Which *mode* is the default is the remaining choice; see Open question 1.

4. **Identity in the email follows the analytics tier.** On Pro the email names the viewer
   when known (signed-in name/email, or the name an anonymous reader gave), the link label,
   pages reached and time on page. On Free the email says *that* a recipient opened *which
   link* and nothing about who — the same line the metrics page draws, so the email is never
   a side channel around the Pro gate. This is also the upsell surface: the Free email carries
   one muted line, "Pro shows who opened it and how long they stayed." (the same line as in
   Email design).

5. **Notify the whole workspace on that document's links, not only the uploader.** A
   teammate who set up the Sequoia link should hear about Sequoia. Membership is the recipient
   set, as it is for the two existing email kinds; each member's own mode applies.

6. **Immediate means "within the next cron tick", i.e. ≤5 minutes**, not synchronous on the
   view request. The ingest path is public, rate-limited and best-effort, and must not grow an
   email send; the cron already runs every five minutes with a lease. Five minutes is
   "while the deck is still open" for every realistic follow-up. If that proves too slow,
   the fix is a shorter cron interval or a change-stream consumer in the realtime service,
   not a send in the request path.

7. **Batch within a tick.** If three recipients open three links in the same five minutes,
   the immediate email lists all three rather than sending three emails. One email per member
   per tick, per document, at most.

8. **Turning it off is a first-class action, reachable from the email itself — decided by the
   owner 2026-09-15.** Because the feature is on by default, the off switch has to be at least
   as easy to find as the email was to receive. Concretely:
   - Every view email carries two footer links: **Turn off these emails** (one click, no sign-in
     round trip beyond what the link already carries, sets this member's mode to `off` and
     confirms on a plain page) and **Change how often** (to the Email preferences block,
     `/dashboard?tab=account#email-preferences`).
   - `off` is a real state that suppresses immediate *and* digest emails for views; it does not
     touch the two existing preferences.
   - The Preferences row shows the current mode with `Off` as a visible option, not buried
     behind a "manage" link.
   - A member who turns it off is never re-enabled by a deploy, a migration or a plan change.
   The one-click link is a signed token (member id + purpose + expiry) rather than the session
   cookie, because the email is opened on phones where the user is not signed in, and an
   unsubscribe that demands a sign-in is one that does not happen.

9. **The Terms of Service and the Privacy Policy say this before the first email goes out —
   decided by the owner 2026-09-15.** Two current statements are contradicted by
   on-by-default:
   - Terms §2 lists "Email notifications about document activity, which you can turn off in
     your settings" — accurate, but it does not say the notifications are on unless turned off,
     and a reader would not infer that from it.
   - Privacy §"How we use information" says we send "document activity notifications and
     digests **you have opted into**". On-by-default is opt-out, so this sentence becomes false
     the day the feature ships.
   Both are amended in M1, before any send: Terms §2 gains a sentence that view notifications
   are sent to workspace members by default and can be turned off per member from any such
   email or from settings; Privacy replaces "you have opted into" with "which are on by default
   and which you can turn off at any time from the email or your settings", and Privacy §5
   (written for viewers) gains one line telling viewers that the person who shared the link
   may be emailed when they open it — that is a disclosure owed to the *viewer*, not only the
   account holder. The dated change-note convention already used in Terms §8 is followed, and
   `tests/credits/gateSplitCopy.test.ts`'s pattern of pinning legal copy in a test is extended
   so the statements cannot silently drift from the behaviour.

## Approach

### Data model

No new collection. Two additions:

- `OrgMembership.viewEmailMode: "off" | "daily" | "immediate"`, default `"daily"`, indexed,
  beside `docUpdateEmailMode` and `repoLinkRequestEmailMode`.
- `NotificationEmailCursorKey` gains `"share_views"`. The cursor's `lastNotifiedAt` for this
  key is `ShareView.createdDate` — the row's creation instant, which is what "a new recipient"
  means and which no maintenance write can move (unlike `updatedDate`; see the
  `lastViewedAt` history in `ShareView.ts`). For returns in the digest, the cursor also has
  to cover `ShareVisit.startedAt`; both are read against the same `lastNotifiedAt`.

  *As built (2026-09-17):* returns have their own horizon on the same cursor document,
  `returnsNotifiedAt`, compared with `ShareVisit.createdDate` (server-stamped, not the browser's
  `startedAt`). A single shared horizon lost returns: an immediate-mode member's cursor moves every
  tick, past returns that only the digest reports, so those returns were never sent, not even after
  a switch to daily. Cursors written before the field existed fall back to `lastNotifiedAt`.

### Event selection

For a member with mode ≠ `off`, the events since their cursor are:

- **New viewers:** `ShareView` rows on documents in their workspace with `createdDate >
  lastNotifiedAt` and `RECIPIENT_ONLY_MATCH`. Joined to `ShareLink` by `shareId` for the label
  and audience.
- **Returns (digest only):** `ShareVisit` rows with `startedAt > lastNotifiedAt`,
  `RECIPIENT_ONLY_MATCH`, whose `(shareId, botIdHash)` already had a `ShareView` before the
  window — a reader coming back, not a first open.

Archived and deleted documents are excluded; disabled or expired links are *included* if a
view somehow landed (it cannot, the link refuses — but the exclusion is the reader's problem,
not the notifier's, so do not filter on link state and accidentally hide real traffic).

### Sending

`sendNotificationEmails` gains a third block alongside `doc_updates` and `repo_link_requests`,
using the same helpers: `trySendEmail` (a failure logs and does **not** advance the cursor, so
the event is retried next tick), `upsertCursor`, `shouldSendDailyUtc`, and the `lastDigestDay`
guard that stops a digest going twice on an overlapping run. Recipients come from the same
membership scan.

Immediate mode: every tick, one email per member per document with the new viewers since the
cursor. Daily mode: at the UTC end-of-day tick, one digest email per member across all their
documents, with new viewers *and* returns, grouped by document then by link.

*As built (2026-09-17):* returns go only in the digest (decision 1), for **both** modes. An
immediate member also gets a returns-only digest at the end-of-day tick ("N people came back to
your documents today") when anyone came back that day; with no returns, no digest. Their new viewers
are never repeated in it. This is what verification 2 describes for a member who was on immediate
in verification 1. The owner can reverse it (immediate members never hear about returns) by
skipping the returns digest for immediate members. The `returnsNotifiedAt` horizon must still stay
separate, or a switch to daily loses the returns from the immediate period.

### Email design

The email is the product for this feature; most of the work is here.

**Subject.** Immediate: `Sequoia opened "USAVX MEMO"` when the link has a label, else
`Someone opened "USAVX MEMO"`. Batched immediate (several new viewers of one document in one
tick, decision 7): `N people opened "TITLE"`, e.g. `3 people opened "USAVX MEMO"`, whatever the
links. Digest: `3 people opened your documents today` (or `since Sep 12` for a longer window).
Never "New view" — the subject has to be scannable in a notification banner.

**Preheader.** A hidden first line sets the inbox preview: link and how far on Pro (with the
viewer's name when known), link and when on Free, counts for the digest. It follows the same
identity rule as the body, so a Free preheader never names anyone or says how far they read.

**Body, immediate (Pro):** who (name, or "Someone on the Sequoia link"), which link and
audience, when, and how far they got (`4 of 12 pages · 3m 20s`). A "Who" row appears only
when a real name or email is known, never "Who: Someone". Immediate emails only ever report
first opens, so they do not say so. The default link reads "Default link", as in the links UI.
When several viewers in one email all came through the same link, the link is shown once under
the heading and each viewer is one line, `08:02 UTC · 1 of 1 page · 15s` (prefixed with the
name when known); across several links each line names its link instead. One primary action:
**See what they read →** deep-linked to `/doc/:id/metrics?shareId=<slug>`, which already scopes
the whole page to that link.

**Body, immediate (Free):** which link was opened and when; no name, no pages, no time (a
batch on one link lists times only). The same button, and one muted line: *Pro shows who
opened it and how long they stayed.*

**First-view honesty.** When the viewer is anonymous and the open is within ten minutes of
the link being created, add one line: *If this was you checking the link, sign in first next
time and we'll know not to count it.* This is the same limitation the MCP tool description
now states; the email must not claim certainty the data does not have.

**Digest:** one section per document, one line per link, viewers and returns as counts with
the top viewer named on Pro. Footer link to the document's metrics.

**Footer, every view email:** *You get this because someone opened a link to a document in
your workspace. **Turn off these emails** · **Change how often**.* The off link is the signed
one-click token (decision 8); "Change how often" lands on the Email preferences block
(`/dashboard?tab=account#email-preferences`). The line names the reason the email exists,
because an email that arrives by default owes the reader that much.

**One-click unsubscribe headers.** Every view email sends `List-Unsubscribe: <off URL>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so Gmail and Yahoo show their
own Unsubscribe button instead of leaving "Report spam" as the easy way out. The off route
accepts that POST (form body `List-Unsubscribe=One-Click`, token in the query string), sets the
mode to `off` idempotently and answers 200 with no page.

**Mail-client rendering.** Inline styles and tables only; a small "LinkDrop" wordmark at the
top of the card; the card held at 560px in Outlook desktop by an `mso` conditional table; the
button's background and padding on its table cell (bulletproof in Outlook); long titles and
labels wrap (`word-break:break-word; overflow-wrap:anywhere`) instead of widening the card on a
phone; `color-scheme` meta set to light only; footer links 13px with padded tap targets.

**Plain text and HTML both**, through `sendTextEmail`'s existing transport. `EMAIL_TRANSPORT=
console` in dev prints the payload, which is how the copy gets reviewed before anything is
sent.

### Web app

- **Preferences → Notifications:** a third row, "When someone opens a link", with the three
  modes and `Off` shown as a peer of the other two, above the two existing rows because it is
  the one people come for.
- **One-click off from the email:** `GET /api/notifications/views/off?t=<token>` verifies a
  signed token (member id, purpose `view_emails_off`, 30-day expiry), sets the mode to `off`,
  and renders a plain confirmation with a link back to Preferences to change it. Idempotent;
  a used or expired token still lands on the same page with the current state. No sign-in
  required, for the reason in decision 8.
- **Legal pages:** Terms §2, Privacy "How we use information" and Privacy §5 updated per
  decision 9, with the dated note, in the same commit as the pipeline so they cannot ship apart.
- **Metrics page and links table:** no change. The email deep-links into the filtered metrics
  view that already exists.
- **Onboarding:** after the first share link is created, one dismissible line on the document
  page: *You'll get a daily email when people open this. Change to instant in Preferences.*
  Tells the user the feature exists at the moment it becomes relevant.

### API and MCP

- `GET/PATCH /api/orgs/:id/members/me/notifications` (or wherever the two existing modes are
  edited — reuse that route) gains `viewEmailMode`.
- **No MCP tool.** An agent does not need to receive email. `lnkdrp_whoami` could report the
  member's modes so an agent can tell a user "you have view emails set to daily"; that is a
  one-field addition and goes in only if cheap.

### Activity and realtime

Unchanged. `share.viewed` already lands in the feed and on the WebSocket; the email is the
channel for the owner who is *not* watching either.

### Migration

None for data. Existing members get `viewEmailMode` from the schema default (`daily`) on read,
so the first digest goes out the day after deploy. The cursor is created lazily on first send,
with the existing "default lookback when a cursor is missing" rule so nobody receives a digest
of the last six months on day one.

*Implementation note (2026-09-16):* the build does not use a lookback for a missing cursor. The
first tick that sees a member with no `share_views` cursor creates it at that moment and sends
nothing (no backfill), so views before that tick are never emailed. The 7-day
`defaultLookbackDays` only caps the window of an existing cursor that is older than 7 days. A
member on `off` has the cursor moved to now every tick, so views while off are dropped. Because
of that, the cron scans every live membership, not only those with some email kind on.

## Verification

1. Open a link as a signed-out recipient → within one cron tick, the owner (mode `immediate`)
   receives exactly one email naming the link; a second page turn sends nothing.
2. Open the same link again in a new tab → no immediate email; it appears as a return in that
   day's digest (for an immediate member, the returns-only digest; a member who switches from
   immediate to daily before the digest also sees it).
   *As built:* a return counts only when the reader's first `ShareView` is at or before the
   member's window start; a first open and a return inside the same digest window show as one
   new viewer.
3. Open your own link while signed in → no email, and `ownerPreviews` on the metrics API
   increments instead.
4. Three recipients open three links within five minutes → one immediate email listing all
   three, not three emails.
5. Free workspace → the email names the link and not the viewer, and carries the Pro line.
   Flip the workspace to Pro → the same event's email names the viewer and pages.
6. Kill the transport (bad `RESEND_API_KEY`) → the send fails, the cursor does not advance,
   and the next tick retries the same event once the key is fixed. No duplicate when it
   succeeds.
   *As built:* an immediate round stops at the first failed document and the cursor moves to
   just before that document's earliest event, so a document sent earlier in the same round can
   repeat. A failed digest keeps its cursor and retries only in the 23:00–23:59 UTC ticks, then
   the next day.
7. Two cron ticks overlap → the lease makes the second skip; the digest goes once per UTC day.
8. `tests/share/traffic.ts --readers 6` with a member on `immediate` → the printed console
   emails match the readers the script created, minus none (no owner previews in that run).
9. Click **Turn off these emails** in a received email while signed out → the confirmation
   page renders, the member's mode reads `off` in Preferences, and the next tick sends nothing
   for a fresh view. Click the same link again → same page, still off, no error.
10. A new member joining a workspace after deploy → their mode is the default (on), and their
    first email carries the footer with the off link.
11. Terms §2 and Privacy say notifications are on by default and can be turned off, and the
    copy test fails if either sentence is removed.

## Milestones

### M1 — Pipeline, off switch and legal copy (no preferences UI yet)
- `viewEmailMode` on membership (default on), `share_views` cursor key, event selection for
  new viewers, the immediate block in `sendNotificationEmails`, plain-text email with the
  footer and the signed one-click off route, console transport.
- Terms §2, Privacy "How we use information" and Privacy §5 amended with the dated note, and
  the copy test, **in this milestone** — the legal statements must be true before the first
  send, so they cannot wait for M3.
- Proves: verification 1, 3, 6, 7, 9, 10, 11 with the mode set directly in the database.

### M2 — Preferences and digest
- Notifications row in Preferences; the daily digest with returns; the onboarding line.
- Proves: verification 2, 4.

### M3 — The email itself
- HTML template, Pro/Free identity split, first-view honesty line, deep link into the filtered
  metrics page; copy reviewed against console output before the transport is switched on.
- Proves: verification 5, 8.

## Open questions

All three are **resolved for v1 (2026-09-16)**; the original question stays below each resolution.

- **Resolved 1 — default mode is `daily`.** `OrgMembership.viewEmailMode` defaults to `"daily"`
  and readers treat a missing value as `"daily"`. The "first three views are immediate" middle
  path is not built; the onboarding line on the document page tells the member the emails exist
  and that they can switch to instant.
- **Resolved 2 — `immediate` is available on every plan.** Identity is what is Pro-gated
  (decision 4): a Free email says that a recipient opened which link, a Pro email says who.
- **Resolved 3 — digests run on UTC days for v1.** The digest goes on the end-of-day UTC tick
  like the other two kinds; `docUpdateDigestTimezone` stays unused. Quiet hours are a follow-up.

Implementation notes (where the draft left the location open): the preference is read and
written through the existing `GET/PATCH /api/orgs/active/notification-preferences` route; the
one-click token lives in `src/lib/notifications/viewEmailToken.ts`, signed with
`LNKDRP_NOTIFICATION_TOKEN_SECRET` (falls back to `NEXTAUTH_SECRET`); the pipeline block is
`src/lib/notifications/viewNotifications.ts`, called from `sendNotificationEmails`.

1. **Which mode is the default — `daily` or `immediate`?** On-by-default is decided; this is
   the remaining half. `daily` protects the inbox; `immediate` is the moment the product feels
   alive, and a founder who gets nothing the day an investor opens the deck may never learn the
   feature exists. A middle path: **first three views ever are immediate regardless of mode**,
   then the chosen mode applies. Decide before M1.
2. **Is `immediate` a Pro feature?** It is the obvious plan lever and DocSend gates exactly
   this. The draft leaves it on every plan and gates *identity* instead, because a Free user
   who gets "Someone opened the Sequoia link" within five minutes and cannot see who is the
   best upsell email the product will ever send.
3. **Quiet hours.** A digest at 00:00 UTC lands at 5pm on the US west coast and 9am in Berlin.
   `docUpdateDigestTimezone` already exists as an unused field. Wire it, or accept UTC for v1?

## Future

- Per-link override: "always email me instantly about this link" for the two that matter.
- Download notifications as a separate event kind, reusing the same cursor mechanics.
- A weekly summary for `off` users — "your documents were opened 14 times this week" — as a
  re-engagement email rather than a notification.
- Slack via a webhook URL on the workspace, once there is a second channel worth abstracting.
- An MCP tool that lets an agent *subscribe* on the user's behalf, so "tell me when Sequoia
  opens it" is one sentence.
