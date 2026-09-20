# PRD — The notification queue

**Status:** Approved 2026-09-19, building. Replaces the cursor-scanning delivery model in
`src/lib/notifications/sendNotificationEmails.ts`.
**Owner:** chrissanz
**Last updated:** 2026-09-19
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-view-notifications](./lnkdrp-view-notifications.md) · [FEATURES](../FEATURES.md) · [CRON](../CRON.md)

---

## Problem

Today nothing records that an email *needs to be sent*. The cron reconstructs that at run time by
scanning `ShareView` / `Upload` / request rows for anything newer than a per-member high-water mark
in `NotificationEmailCursor`. Everything wrong with delivery follows from that one choice:

- **The backlog is unreachable.** A member with no cursor gets one created at the current time and
  nothing is sent. Verified on 2026-09-19: twelve members had no `share_views` cursor at all, so
  every view since the feature shipped was permanently un-emailable. Two lnkdrp emails have ever
  been delivered to the owner's mailbox, both transactional, the most recent in January.
- **A failed send is not a retry, it is a rewind.** "An immediate round stops at the first failed
  document and the cursor moves to just before that document's earliest event." Whether an event is
  retried depends on where it sat in a batch, and a document already sent in that round is sent
  again. There is no attempt count and no backoff.
- **Nothing is inspectable.** "Was this person emailed about that view?" can only be answered by
  comparing a timestamp against a scan, and "what is waiting to go out?" cannot be answered at all.
  The admin Emails page reports run totals, which is the shape of the data, not the question.
- **A preference change loses events.** A member on `off` has their cursor moved to now every tick,
  so everything that happened while they were off is gone the moment they turn it back on.
- **The scan is unbounded work.** Every tick re-queries every collection for every member, whether
  or not anything happened.

## Goal

When something happens that someone should hear about, that fact is **written down at that moment**.
The cron's only job is to deliver what is written down, retry what fails, and stop retrying what
cannot succeed — and at any moment it is possible to ask what is pending, what was sent, and what
gave up.

## Non-goals

- A general-purpose job queue. This carries notifications; uploads keep their own pipeline.
- A new transport. Resend and `sendTextEmail` are unchanged, `EMAIL_TRANSPORT=console` still works.
- Changing what any email *says*, or the Pro/Free identity rules inside them.
- Push, SMS or Slack. Still email only.
- Backfilling history. Nothing has ever sent; there is no backlog worth migrating, which makes this
  a clean cutover rather than a dual-write migration.

## The model

`NotificationQueueModel`, collection `notificationqueue`. One row is **one email owed to one
person**, not one event: an event affecting four members enqueues four rows, so retry, preference
and failure are all per recipient.

```ts
{
  orgId, userId,                       // the member who is owed the mail
  kind: "share_views" | "doc_updates" | "repo_link_requests",
  dedupeKey: string,                   // UNIQUE — see below
  event: {                             // enough to render without re-deriving
    docId?, projectId?, shareId?, uploadId?, requestId?,
    viewerKey?, viewerName?, viewerEmail?, version?,   // viewerKey is the PERSON — see decision 9
  },
  occurredAt: Date,                    // when the underlying thing happened
  status: "pending" | "sending" | "sent" | "skipped" | "dead",
  attempts: number,
  nextAttemptAt: Date,
  claimedAt: Date | null,
  lastError: string | null,
  sentAt: Date | null,
  skippedReason: string | null,        // "member off", "document deleted", …
}
```

Indexes: unique `{dedupeKey}`; `{status, nextAttemptAt}` (the claim); `{orgId, userId, kind, status, occurredAt}`
(digest grouping, and the "was this sent?" question); `{status, claimedAt}` (stale recovery);
TTL on `sentAt` at 30 days so the collection does not grow without bound while staying long enough
to answer questions about what went out.

## Decisions

### 1. Enqueue at the event, not at the tick

The write happens where the thing happens, immediately after the primary write, `void`-style and
best-effort — the same contract `recordActivity` already has, for the same reason: a notification
that fails to enqueue must never fail the reading, the upload or the request that caused it.

| kind | enqueued at | condition |
|---|---|---|
| `share_views` | the stats ingest, where `share.viewed` is recorded | a `ShareView` row was **created**, and `!ownerPreview` |
| `doc_updates` | the upload processor, on a completed replacement | `isReplacement` and the document still exists |
| `repo_link_requests` | the upload processor, on a completed **first** version | `viaUploadSecret` and `!isReplacement` |

Fan-out to members happens **at enqueue**, so the queue literally is the mail that is owed.

### 2. The preference is read at send, not at enqueue

Enqueue for every member regardless of their mode; resolve `viewEmailMode` /
`docUpdateEmailMode` / `repoLinkRequestEmailMode` when the row is claimed. A member who turns them
off has their pending rows marked `skipped` rather than deleted, so the record of the decision
survives, and a row that fails or waits for a digest is unaffected by a preference read minutes
earlier.

**Correction, 2026-09-19.** This decision originally also claimed that "a member who turns
notifications on today then hears about yesterday". It does not, and should not. The tick runs
every five minutes, so an `off` member's rows are skipped within five minutes of being written;
only the five-minute gap is ever recoverable. Leaving them `pending` instead would give the
promise, at the cost of an unbounded backlog for anyone who leaves notifications off and a surprise
flood the moment they turn them on — which is worse than the thing it fixes. The rule stays; the
sentence was wrong, not the code. Where deferral genuinely happens is `daily` members, whose rows
wait unclaimed for the end-of-day tick, and failed sends, which retry.

### 3. `dedupeKey` is the whole idempotency story

A unique index, built from the event's own identity — `share_views:<userId>:<shareViewId>`,
`doc_updates:<userId>:<uploadId>`, `repo_link_requests:<userId>:<requestUploadId>`. A duplicate
insert is caught and ignored (E11000 means "already owed"), so a retried request, a replayed
heartbeat or two racing writers cannot produce two emails. This replaces the ad-hoc guards that
currently live at each call site.

### 4. Claiming is atomic, and a crashed run recovers by itself

`findOneAndUpdate({status: "pending", nextAttemptAt: {$lte: now}}, {$set: {status: "sending",
claimedAt: now}})`, in a bounded batch — the same idiom the upload processor already uses for its
`uploaded → processing` transition, including the stale-claim sweep: a row `sending` with
`claimedAt` older than `CLAIM_STALE_MS` goes back to `pending`, because the alternative is a row
that is stuck forever because a process died mid-send.

### 5. Retries back off, and giving up is a state

`attempts += 1`, `nextAttemptAt = now + backoff(attempts)` with backoff `1m, 5m, 30m, 2h, 12h`, and
after `MAX_ATTEMPTS` (5) the row becomes `dead` with `lastError` kept. Dead rows are never retried
automatically and are visible on the admin Emails page — a queue that silently drops mail is the
thing being replaced, so the failure has to be somewhere a person can see it.

### 6. Digests are a query over the queue, not a second mechanism

An `immediate` member's row is sent on the next tick. A `daily` member's rows stay `pending` until
the end-of-day UTC tick, which groups every pending row for that member and that kind into one
email and marks them all `sent` together. Both modes read the same rows; only the grouping differs.
This is what removes `lastDigestDay` and the returns-horizon bookkeeping from the cursor model.

### 7. Cursors stay in the tree, unused, for one release

`NotificationEmailCursor` is no longer read or written by the send path, but the model and its
collection remain so that work in flight against it (the reader-verification feature being built in
parallel) does not break at import time. It carries a deprecation note pointing here, and
`wasNotified({orgId, userId, kind, before})` — a queue-backed helper answering "has this member
already been told about this?" — is exported for callers that used to infer it from a cursor. That
question now has an exact answer rather than a high-water-mark approximation.

### 9. `event.viewerKey` is the person, and a sent row records which viewer it covered

The key is the **bare digest**, normalised through `splitProjectViewerKey` — never the
`<digest>.<docId>` composite a project link writes. Three separate bugs this month came from those
two shapes being compared literally, so the queue stores only the person and the document lives in
its own field.

That makes a `share_views` row a record of *which reader* a given member was told about, not merely
that a notification went out at time T. Which in turn is what lets a second question be answered
exactly rather than inferred:

```ts
sentNotificationsForViewer({ orgId, viewerKey }): Promise<Array<{ userId, sentAt }>>
```

— the members for whom a `share_views` notification **including this viewer** has actually been
sent, and when. `status: "sent"` only: not enqueued, not claimed, not failed, not a high-water mark
that swept past. The caller's premise is that a specific wrong email is sitting in a specific inbox,
so anything short of delivered is not evidence.

Per member rather than a single boolean, deliberately: in a workspace where one member is on
`immediate` and another on `daily`, the first has been told and the second has not, and treating
them the same means mailing somebody about something they are about to be told properly anyway.

This exists for the reader-verification work being built in parallel
(`src/lib/share/anonymousNoticeAudience.ts`), which currently answers it from cursor timestamps —
an inference that, on freshly initialised cursors, reads as "yes, they were told" about readers
nobody was ever told about.

### 8. The cron keeps its name and schedule

Still `notification-emails`, still `*/5 * * * *`, still in `src/lib/cron/jobs.ts` with its `what`
and `why`. What changes is the body. The CLI keeps `--dry-run` semantics (dry unless `--send`) and
must remain side-effect free, including not claiming rows — that property is what made today's
investigation safe and it is worth keeping.

## Milestones

**M1 — the queue.** Model, indexes, `enqueueNotification()` with dedupe, `claimBatch()`,
`markSent`/`markFailed`/`markSkipped`, backoff, stale recovery, `wasNotified()`. Unit-tested against
the filters they issue.

**M2 — the writers.** The three enqueue call sites, each after its primary write, each `void` and
best-effort.

**M3 — the reader.** `sendNotificationEmails` rewritten to drain the queue: claim, resolve
preference, render (unchanged bodies), send, mark. Digest grouping at the end-of-day tick. Cursor
reads and writes removed from this path.

**M4 — visibility.** The admin Emails page gains pending / sent / dead counts and a dead-letter
list with `lastError`, and the cron board's row for this job reports queue depth rather than only
the last run.

## Known gap: returns are not queued yet

A digest has always reported "N opened, **M came back**". Only `ShareView` creation enqueues, and a
return is a `ShareVisit`, so `views.daily.returns` is currently always 0 and the returns-only digest
an `immediate` member used to get at the end of the day no longer exists. The composer still takes
its `returns` argument and the call site passes `[]`, so nothing about the email shape has to move
when they are queued.

Attempted on 2026-09-19 and backed out deliberately, because a half-wired version is worse than the
gap — return rows would have been enqueued, deferred by the immediate path and then never consumed
by the digest, accumulating as `pending` for ever. Two concrete obstacles for whoever finishes it:

1. **The reader needs `loadVisitEventsByIds`.** `loadNewViewerEventsByIds` exists and
   `loadVisitEvents` exists, but only over a *range*; the queue hands the sender a set of row ids.
   The mirror is mechanical, and `ReturnEvent` additionally needs `firstViewAt` / `firstVisitAt`,
   which the range loader already knows how to derive.
2. **The source id cannot contain a colon.** `sourceIdOf` reads the last segment of
   `<kind>:<userId>:<sourceId>`, so a key like `visit:<visitIdHash>` silently loses its prefix.
   Use the `ShareVisit` `_id` as the source id, exactly as the other kinds use their row id, and
   distinguish returns by a field on `event` rather than by the shape of the key.

Neither is hard; both are the sort of thing that is discovered at the wrong moment.

## Open questions

1. **Should `dead` rows be retryable from the admin page?** A button is easy and a queue with no
   manual retry is annoying at exactly the wrong moment. Recommendation: yes, in M4, as a single
   "retry" that resets `status` and `attempts`.
2. **How long should `sent` rows live?** 30 days is proposed, chosen so the reader-verification
   feature can ask "was the anonymous mail already sent" long after the fact. If that feature wants
   a permanent answer, it should keep its own record rather than making this collection permanent.
3. **Per-workspace throttle?** A data room opened by two hundred people in an hour enqueues two
   hundred rows per member. The digest path absorbs this; an `immediate` member gets two hundred
   emails. The current code caps at 20 events per member per tick, which drops the rest silently.
   Recommendation: keep a cap, but make the overflow roll into the next tick — which the queue makes
   natural and the cursor model made impossible.
