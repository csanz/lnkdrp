# PRD — Slack (workspace updates in a channel you choose)

**Status:** Decisions 1–12 and open questions 1 and 4 locked 2026-09-24 (every plan; an Integrations sidebar entry and page). M1 built the same day: sidebar entry, `/integrations` and `/integrations/slack`, `SlackConnection`, install and callback routes with signed state, encrypted webhook storage, settings API, test message, activity rows, purge. M2 built 2026-09-24: `SlackOutbox` ledger, `enqueueSlackPosts` at the four event sites (posted from `after()` at the moment), `drainSlackOutbox` from the notification-emails and visit-briefs crons with the queue backoff ladder, project routing (`routeSlackConnections`), the 30-a-minute burst cap, the four Block Kit renderers with the plan-gated reader identity, purge coverage and tests. Waiting on the Slack app credentials (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`) for the first real connect. M3 built 2026-09-24: the Projects section on each channel card (rooms and request inboxes; picking a project on one card pulls it from any other, one project posts to one channel), routing includes the request inbox a document arrived through. M4 built 2026-09-24: `integrations.slack` on `/api/agent/whoami` and `lnkdrp_whoami`, FEATURES.md section, CHANGELOG-2026-09-24, DEPLOY.md 4.7 and env rows, PRODUCTION.md ledger row.
**Owner:** chrissanz
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-view-notifications](./lnkdrp-view-notifications.md) · [lnkdrp-notification-queue](./lnkdrp-notification-queue.md) · [lnkdrp-visit-briefs](./lnkdrp-visit-briefs.md) · [REALTIME](../REALTIME.md) · [CRON](../CRON.md)

---

## Problem

Everything the workspace learns about its documents leaves by email: a recipient opened a link,
the brief written after their visit, a document replaced, a file dropped into a request inbox.
Email is the right record and the wrong place to notice things. The people who send decks live
in Slack all day, and the moment worth reacting to ("the partner just opened it and spent four
minutes on pricing") is worth ten seconds of attention in a channel, not a message in an inbox
that is read twice a day.

The notification design anticipated this. The view-notifications PRD closes with "Slack via a
webhook URL on the workspace, once there is a second channel worth abstracting"
(`docs/prds/lnkdrp-view-notifications.md:376`). There are now five event kinds behind one queue,
each with a renderer that already knows the document, the link, the reader and the brief. That is
the second channel.

## Goal

A workspace owner connects a Slack channel once, choosing the channel inside Slack's own install
screen. From then on the events they pick post there as short messages with a link back:

- a recipient opened a share link (the same "new viewer" moment the view email fires on),
- a visit brief was written after a recipient finished reading (headline, body, the link),
- a document was replaced (version, what changed),
- a request inbox received a file.

Messages are immediate, one per event, and carry exactly what the equivalent email carries at the
workspace's plan tier. The connection is per workspace, not per member, and lives on a new
**Integrations** page in the app, reached from its own entry in the left sidebar. Slack is the
first integration listed there; the page is built to list more.

## Non-goals (v1)

- Slash commands, replies, or anything the bot listens for. This is outbound only.
- Per-member Slack DMs, or more than one channel per project. A workspace can hold several
  channels and route projects to them (decision 2); one project posts to one channel.
- A Slack daily digest. Immediate only; the daily email digest already exists for the rest.
- Interactive buttons (approve a download request from Slack). Later, and it needs a bot token.
- Slack as a sign-in method, or Slack as an MCP tool.
- Coalescing a burst of views into one message. Capped instead (decision 10); folding is Future.

## Proposed decisions (to lock)

1. **Incoming webhook, not a bot.** The Slack app requests one scope, `incoming-webhook`. That
   scope makes Slack's authorization screen include the channel picker, and the OAuth response
   returns `incoming_webhook: { url, channel, channel_id, configuration_url }` bound to that
   channel. So the channel is chosen where the user already is, private channels work with no
   invitation step, we never call `conversations.list`, and there is no bot user to manage.
   Changing channel is "Reconnect" (the same flow again). A bot token (`chat:write`) is what
   buttons and DMs would need; it is the upgrade path, not v1.

2. **A workspace holds channels; one is the default; projects route to channels.**
   `SlackConnection` is unique on `{orgId, channelId}`, and exactly one per workspace carries
   `isDefault`. "Add channel" runs the install again and returns one more webhook bound to one
   more channel; there is no channel listing and no bot. Each project can be mapped to one
   channel from the card (`projectIds` on the connection); the mapping is ours and needs no Slack
   call. Routing for an event: the document's projects that are mapped post to their channels
   (a document in two mapped rooms posts to both); anything unmapped posts to the default. A
   workspace with only a default behaves exactly as if the feature had one channel. Connecting,
   mapping and disconnecting take `requireOrgRole(admin)`, like starting a subscription; a
   member or viewer cannot point the workspace's traffic at a channel. Each connection records
   who installed it.

3. **The webhook URL is a secret and is stored as one.** AES-256-GCM at rest with a key derived
   by HKDF from `LNKDRP_SLACK_SECRET`, falling back to `NEXTAUTH_SECRET`, the same per-purpose
   convention as `viewEmailToken.ts` and `realtime/ticket.ts`. It is decrypted only to post, is
   never logged, and never appears in an API response or the admin pages (team and channel name
   do). A leaked webhook URL lets anyone post into the customer's channel.

4. **Posts happen at the event, ledgered in an outbox, retried by the cron.** Email deliberately
   never sends in the ingest path (a queue, a five-minute cron). Slack is different: a view that
   reaches the channel five minutes later is the feature failing. So each event site writes one
   `SlackOutbox` row and posts it in `after()`, outside the response, with a three-second timeout.
   Success marks the row `sent`; failure leaves it `pending` with backoff, and the
   `notification-emails` cron drains pending rows every tick (`claimBatch`-style atomic claims,
   `MAX_ATTEMPTS` 5, same `BACKOFF_MS` ladder as the queue). The row's `dedupeKey` is unique, so
   an event that fires twice posts once. Nothing here can slow or fail the request that caused it.

5. **Exactly the email's events, at exactly the email's moments.** Slack posts are enqueued at
   the same four call sites that enqueue the email kinds, with the same dedupe source:
   - `share_views` (`stats/route.ts`, a new viewer on a link) → "opened",
   - `visit_briefs` (`visitBriefs.ts` `announceAndEnqueue`) → "brief",
   - `doc_updates` (`process/route.ts`) → "replaced",
   - `repo_link_requests` (`process/route.ts`) → "received".
   `doc_uploads` (a teammate added a document) is not posted: the channel is for what recipients
   do, and the feed already has it. Return visits are covered by the brief. This keeps one
   definition of "an event happened" for both channels.

6. **Content follows the plan, as email does.** On Free, `share.viewed` carries no viewer
   identity and the view email says "someone"; the Slack message says the same. Briefs are Pro
   (the recap fallback posts its one line). The renderer takes the same inputs the email round
   builders take, so the two cannot disagree about what a workspace is allowed to see.

7. **Per-event switches on the connection, all on by default.** `events: { views, briefs,
   docUpdates, requests }`. Off means the outbox row is not written. These are workspace
   switches, distinct from each member's email modes; the member preferences stay untouched.

8. **Block Kit with a plain-text fallback, one message per event, no threads.** A header line,
   a context line, one link. Reader name as text, never as a Slack mention. Under 300 characters
   of prose. The brief message is the exception: headline, the ≤80-word body, and the link.

9. **Slack's answer decides the connection's state.** `ok` → `lastPostAt`. `404`/`410` with
   `no_service`, `channel_not_found`, `invalid_token` → the connection becomes `revoked` with
   `lastError`; the outbox stops for it; the Integrations page shows "Slack disconnected, the
   channel or app was removed. Reconnect." on the card and the detail page. `429` → honour `Retry-After` and requeue. `5xx` →
   retry. Five failures in a row also flip `revoked`, with the error shown.

10. **A cap, not a flood.** Slack allows roughly one post per second per webhook. The drain
    sends serially per connection, and any connection that has posted 30 messages in the last
    minute has the rest of that minute's events marked `skipped: burst` with a single "…and N
    more opens on <doc>" message at the end of the window. A deck blasted to a mailing list
    must not fill a channel.

11. **Disconnect deletes our copy and tells Slack.** `DELETE` removes the row and its pending
    outbox rows, and calls `auth.revoke` with the webhook's token when Slack gives one; the
    installer's `configuration_url` is shown so the owner can also remove the app on Slack's side.
    Deleting the workspace or the owner's account does the same (the purge already walks
    per-org collections; `slackconnections` and `slackoutbox` join that list).

12. **Dev uses a tunnel.** Slack requires an HTTPS redirect URL. Local development connects
    through ngrok (`docs/DEV.md` already documents it) or a preview deployment, with that host
    added to the Slack app's redirect URLs. The callback validates a signed `state` and never
    trusts the host header for the redirect.

## Approach

### Data model

`src/lib/models/SlackConnection.ts` (collection `slackconnections`):

```ts
{
  orgId: ObjectId,                                 // unique with channelId
  teamId: string, teamName: string,
  channelId: string, channelName: string,          // "#deals"
  isDefault: boolean,                              // exactly one true per workspace
  projectIds: ObjectId[],                          // projects routed here (decision 2)
  webhookUrlEnc: string,                           // AES-256-GCM, decision 3
  configurationUrl: string | null,
  installedByUserId: ObjectId,
  events: { views: boolean, briefs: boolean, docUpdates: boolean, requests: boolean },
  status: "active" | "revoked",
  lastPostAt: Date | null, lastError: string | null, consecutiveFailures: number,
  createdDate, updatedDate
}
```

`src/lib/models/SlackOutbox.ts` (collection `slackoutbox`): `orgId`, `connectionId`, `kind`
(`views|briefs|docUpdates|requests`), `dedupeKey` (unique, `${kind}:${orgId}:${sourceId}`),
`event` (the same embedded shape as `NotificationQueue.event`), `occurredAt`, `status`
(`pending|sending|sent|skipped|dead`), `attempts`, `nextAttemptAt`, `claimedAt`, `claimToken`,
`lastError`, `sentAt`, `skippedReason`; TTL on `sentAt` after 30 days. Deliberately a sibling of
`NotificationQueue` rather than a `channel` field on it: the queue is per member and its
send-time preference lookup is per member; this is per workspace.

### Routes

- `GET /api/slack/install` (admin): signs `state = { orgId, userId, exp }` with the HKDF key,
  redirects to `https://slack.com/oauth/v2/authorize?client_id&scope=incoming-webhook&state&redirect_uri`.
- `GET /api/slack/oauth/callback`: verifies `state`, exchanges `code` at `oauth.v2.access` with
  `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`, upserts `SlackConnection` (encrypting the URL),
  records `integration.slack_connected` in the activity feed, redirects to
  `/dashboard?tab=notifications&slack=connected`. Any failure redirects with `slack=error` and
  a short reason; nothing partial is stored.
- `GET /api/orgs/active/slack` (member): `{ connected, teamName, channelName, events, status,
  lastPostAt, lastError, configurationUrl }`. Never the URL.
- `PATCH /api/orgs/active/slack` (admin): the four event switches.
- `POST /api/orgs/active/slack/test` (admin): posts "LinkDrop is connected to #channel" through
  the same sender, so the first message a customer sees is proof.
- `DELETE /api/orgs/active/slack` (admin): decision 11.

### The sender

`src/lib/slack/post.ts`: `postToSlack(connection, blocks, text)` with a 3 s `AbortController`,
returns a typed outcome (`sent | retry(after) | revoked(reason)`), and never throws.
`src/lib/slack/outbox.ts`: `enqueueSlackPost` (resolves the target connections with
`routeConnections(orgId, docId)` from decision 2, writes one row per connection, then
`after(() => drainOne(row))`), `drainSlackOutbox({ workspaceId?, now })` for the cron. `src/lib/slack/messages.ts`: the four
renderers, taking the same inputs as the email round builders in `sendNotificationEmails.ts`
(`NewViewerEvent` + `ViewLinkInfo`, `VisitBriefEntry`, the doc-update item, the repo-link item).

### The cron hook

`src/app/api/cron/notification-emails/route.ts` calls `drainSlackOutbox()` after the email run,
under the same lease; the `visit-briefs` cron calls it scoped to its workspace in the same tick,
mirroring what it does for brief emails. No new cron entry.

### Surfaces

- **Sidebar: an "Integrations" entry** below Agents, in the same hand-written button pattern
  as the other five entries in `LeftSidebar.tsx` (`pathname.startsWith("/integrations")` for
  the active state). Visible to every member; connecting takes admin (decision 2).
- **`/integrations`** (`src/app/(app)/integrations/page.tsx` + `pageClient.tsx`, the same
  header band as Agents via `AppPageHeader`): a list of integrations, one card each, with a
  logo, a one-line description, a status pill ("Not connected", "#deals", "Disconnected: the
  channel was removed") and a button. Slack is the only card at launch; the list is data-driven
  so the next integration is one more entry. Under the list, a short "More coming" line.
- **`/integrations/slack`** (the detail page the card opens): nothing connected, a paragraph
  and "Add to Slack". Connected: one row per channel (team, channel, the four switches, "Send
  a test message", "Disconnect", the last error if any), a "Default" marker with "Make
  default", an "Add channel" button, and under it a projects table with a channel dropdown per
  project defaulting to "workspace default". The dropdown is the whole mapping UI. The OAuth
  callback lands here (`?slack=connected` / `?slack=error`).
- Notifications tab: one line under the email preferences, "Slack posts are set up under
  Integrations", linking there, so a person looking for "how do I hear about this" finds it.
- Activity feed: `integration.slack_connected` / `integration.slack_disconnected` rows with the
  channel name, so the team can see who wired it up.
- `/a/data/workspaces/:id`: team, channel, status, last post, failures. Not the URL.
- `lnkdrp_whoami`: `integrations: { slack: { connected, channel } }` so an agent can say "this
  will post to #deals" before sharing. Read-only.

### Env

`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (the app's credentials; both required for the feature,
`WANTED` in preflight with the reason "Slack connect is hidden without them"), optional
`LNKDRP_SLACK_SECRET` (decision 3). The Slack app itself: created once at api.slack.com, scope
`incoming-webhook`, redirect URLs `https://www.lnkdrp.com/api/slack/oauth/callback` plus the
tunnel host for development. Without the two variables the card renders "Slack is not set up on
this deployment" and nothing else changes.

## Verification

1. Connect from a Free workspace as owner; Slack's screen shows the channel picker; the callback
   lands on the Slack detail page under Integrations with the channel name; a `SlackConnection` row exists with an
   encrypted URL and no plaintext anywhere (grep the database dump for `hooks.slack.com`).
2. "Send a test message" arrives in the channel within two seconds.
3. Open a share link as a new recipient: one "opened" message, under three seconds after the
   view, with the link back; a second open by the same recipient posts nothing.
4. Finish a visit on Pro: the brief posts in the same cron tick that mails it, with headline and
   body; on Free the recap line posts instead.
5. Replace a document and drop a file into a request inbox: one message each.
6. Turn `views` off: opens post nothing, briefs still do.
7. Delete the channel in Slack, then trigger a view: the connection reads `revoked` with the
   error, the card says so, nothing is retried, and Reconnect works.
8. Point a fake webhook at a server that answers 429 with `Retry-After: 2`: the row is retried
   after two seconds, not before, and the cron picks up a row left pending by a timeout.
9. Blast one link with 40 synthetic opens in a minute: 30 messages, then one "…and 10 more".
10. A member (not admin) gets 403 on install, PATCH, test and DELETE; GET works.
11. Disconnect: the row is gone, pending outbox rows are gone, Slack's `auth.revoke` was called,
    and a view afterwards writes nothing.
12. Account and workspace deletion remove both collections' rows (extend
    `tests/lib/purgeCompleteness.test.ts`).
13. Add a second channel and map one project to it: an open on a document in that project posts
    only there; an open on an unmapped document posts only to the default; a document in that
    project and a second mapped project posts to both; disconnecting the mapped channel sends its
    projects back to the default (unit-tested routing, no Slack needed).

## Milestones

**M1 — Connect.** The Integrations sidebar entry and `/integrations` list page, the Slack detail page, the Slack app, the two env variables, `SlackConnection`, install and callback
routes with signed state, encrypted storage, connect, test message,
reconnect and disconnect, activity rows, admin panel fields. Proves 1, 2, 3, 11, 12 and
verification 1, 2, 7, 10, 11.

**M2 — Events.** `SlackOutbox`, the sender with typed outcomes, the four renderers, the four
enqueue sites behind the event switches, `after()` posting, cron drain, the burst cap, the
purge. Proves 4–10 and verification 3–9, 12.

**M3 — Channels per project.** "Add channel", the default marker, `projectIds` and the
projects table, `routeConnections` with its unit tests, fan-out to several rows per event.
Proves the second half of decision 2 and verification 13.

**M4 — Read-back.** `lnkdrp_whoami.integrations.slack` (channels and the mapping), FEATURES.md,
CHANGELOG, DEPLOY.md env table and the Slack app checklist in section 4, PRODUCTION.md ledger row.

## Open questions

1. **Plan gating.** Resolved 2026-09-24: every plan, with plan-shaped content. (Was: proposed, or Pro-only as
   a reason to upgrade? The view email is on Free; matching it is the consistent answer.
2. **Return visits.** The view email fires on the first open only; return visits reach the owner
   through the brief. Should the Slack "opened" message also fire on a return after 24 hours
   quiet (a cheap "they're back")? Proposed no for v1; the brief says it better.
3. **Burst cap number.** 30 per minute per connection is a guess at "busy but readable". A
   blast to 200 investors would post 30 lines and one summary. Tune after the first real blast.
4. **Where it lives.** Resolved 2026-09-24: a new Integrations entry in the left sidebar with
   its own page, listing Slack first and built for more; the Notifications tab only points
   there.

## Future

- Bot token upgrade: interactive approval of download requests from the message, per-member
  DMs, a `/lnkdrp` command that shares a file from Slack (the MCP already has the tool).
- Folding bursts into one live-updated message (`chat.update`), which needs the bot token.
- Microsoft Teams through the same outbox with a second sender; the outbox is channel-agnostic
  on purpose.
