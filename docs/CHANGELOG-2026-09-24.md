# Changes — 24 September 2026

Written for the `next-release` branch; nothing here is on `main` yet. Grouped by what it affects.

---

## Slack integration (new)

The first entry under **Integrations** in the left sidebar. Decided in `docs/prds/lnkdrp-slack.md`
(decisions 1–12 locked the same day), on every plan, and built in four steps.

**Connect (M1).** `/integrations` lists what the workspace can connect; `/integrations/slack` is
the page. "Add to Slack" runs Slack's own install with the `incoming-webhook` scope, so the person
picks the channel on Slack's screen and private channels work. The callback verifies a signed,
ten-minute install state, exchanges the code, and stores the webhook URL encrypted with a key
derived from `LNKDRP_SLACK_SECRET`. The first channel is the default; "Add channel" adds more. Each
card has four switches, "Send a test message" and "Disconnect". The feed records
`integration.slack_connected` and `integration.slack_disconnected`. Off entirely without
`SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.

**Events (M2).** Four moments post: a recipient's first open, the visit brief after they finish,
a replaced document with the change summary, a file received in a request inbox. One `SlackOutbox`
row per channel per event, written where the emails are queued and posted at once from `after()`;
what fails waits on the email queue's backoff ladder and the `notification-emails` cron retries
it (the `visit-briefs` cron drains after its own send). At most 30 posts a minute per channel,
the rest held a minute with one "and N more" line. A webhook Slack reports gone revokes the
connection instead of retrying forever. Messages are Block Kit with a plain-text twin, one link
back, no mentions; reader identity follows the plan exactly as in the emails, so Free reads
"Someone".

**Channels per project (M3).** Each card has a Projects section: route a room or a request inbox
to the channel from a picker, take it off with the chip. One project posts to one channel, so
picking it on another card moves it. A document in two routed rooms posts to both; anything not
routed posts to the default. Routing counts the request inbox a document arrived through.

**Read-back (M4).** `lnkdrp_whoami.integrations.slack` (and `GET /api/agent/whoami`) reports the
channels, the default, the mapping and the switches for agents; never the webhook, and nothing
writes it. `DEPLOY.md` 4.7 has the Slack app steps and the three variables; `PRODUCTION.md`
carries the ledger row (not configured yet).

Tests: `tests/lib/slack.test.ts` (crypto, state, the sender's outcomes, the settings API's
shape), `slackRouting.test.ts` (which channels an event reaches, the burst cap, the one-channel
rule), `slackMessages.test.ts` (the four renderers and the Free-plan identity gate).

## Also on this branch today

- **Yearly Pro** ($290 a year, two months off): `STRIPE_PRICE_ID_ANNUAL`, the interval toggle on
  pricing, the upgrade modal and `/credits`; yearly has no metered item, so it buys credit packs
  instead of pay-as-you-go (`docs/SUBSCRIPTION.md`).
- **Instant empty states** on metrics, activity, search, requests and tags: the last answer is
  cached per workspace and "nothing here yet" is known from the sidebar snapshot before any fetch.
- **Realtime in production** on Fly (`realtime.lnkdrp.com`) with its own read-only Mongo user and
  `REALTIME_MONGODB_URI`; dev twins for realtime and MCP; `scripts/realtime-e2e.ts` proves a
  socket end to end.
- **Clearer Mongo errors**: an Atlas "not authorized" now names the database the URI asks for and
  the user it authenticates as, at sign-in, at realtime boot and in preflight.
- **No em dashes** anywhere in user-facing text, pinned by `tests/lib/noEmDashes.test.ts`.
- `COMMANDS.md`: every script and command in one searchable place.
