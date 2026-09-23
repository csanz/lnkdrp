## Customer support (Plain)

Support runs in [Plain](https://plain.com). lnkdrp does not host an inbox, ticketing or a help
widget; it feeds Plain the context a ticket needs, publishes the help articles Plain's AI agent
answers from, and links back into the admin area.

Decision (2026-09-23): buy the inbox, build only the glue. See the memory note
`customer-support-plain` for the reasoning against building our own.

### State as of 2026-09-23, end of day

**Working in production**

- support@lnkdrp.com is the support address everywhere in the product (commit d377a4b). It is a
  Google Group; a Google Admin routing rule forwards it to Plain's inbound Postmark address with
  "Also route to original destination" ticked, so the owner still gets a copy. Do not answer
  from that copy; answer in Plain.
- Plain's sending domain is verified: the TXT and CNAME records from Plain's Emails page are in
  Google Cloud DNS, so replies leave as support@lnkdrp.com.
- Chat widget: `NEXT_PUBLIC_PLAIN_CHAT_APP_ID` and `PLAIN_CHAT_SECRET` are in Vercel production
  and `.env.local`. "Require email verification" is on in Plain and the widget always passes
  `requireAuthentication`; a signed-in user is identified by the server-signed email hash and
  sees no code prompt. Verified live: a signed-in message created thread T-3.
- Auto-response "First reply" exists (Settings → Auto-responses), on chat and email, no
  conditions. The form has no delay setting, so it fires at once. **Check the toggle in the list
  is on**: it showed off after the first save.

**Committed on `fix/production-readiness`, not yet deployed** (production returns 404 for these)

- `/support`, the page Plain's reply emails link to (commit 0530886).
- `/help` and `/help/:slug`, ten help articles, and `/sitemap.xml` (commit d1dd939).

**In progress in Plain's UI**

- Plain AI was off for the workspace, which is why Ari showed "Disabled" and why every workflow
  attempt ended in "User not found": Ari does not exist as an assignee until Plain AI is on.
  Enable it at `https://app.plain.com/~/ai`, then create the agent.
- The agent's public name is undecided. Not "Ari" (Plain's brand, means nothing to customers) and
  not a human first name (invites "can I talk to a real person" on every hand-off). Shortlist:
  Skip (recommended), Glide, Fold, Dart, Pilot. Avatars ready on the Desktop: `ari-avatar.png`
  (the site's paper plane on the dark tile) and `ari-character.png` (the plane with a face), both
  240×240.
- The routing workflow. Sidekick built it wrong three times (swapped branches, unresolvable Ari).
  Build it by hand, three blocks, nothing else: trigger **Thread created** → **If/else** Support
  channel IS Chat (Else empty) → **Assign to user** = the agent. The billing branch was dropped;
  the agent's custom instructions hand billing to a human instead.

**Not done**

- `PLAIN_REQUEST_SIGNING_SECRET` (Settings → Request Signing) is set nowhere, so the customer
  cards below answer 503 and nothing renders beside a thread. Needs Vercel production and
  `.env.local`.
- Custom instructions for the agent: paste from `docs/support/plain-setup.md` §3, then change
  the introduction line to the chosen name.
- Knowledge source: Settings → Plain AI → Knowledge Sources → Sitemap
  `https://lnkdrp.com/sitemap.xml`. Only useful after the deploy above.
- Shadow → Live. Stay in Shadow until five test questions from the bubble draft well.
- Templates from Workflows → Templates, in this order: triage feature requests / bugs /
  questions; close threads when customers confirm resolution; follow up and close unanswered;
  flag frustrated customers (point it at a human, priority Urgent); detect urgent threads. Skip
  Slack, SLA, Sidekick investigations and cancel-and-refund for now.
- Help articles and Ari only know about the personal-workspace flow the docs describe; nothing
  yet about the waitlist beyond one hedged line in getting-started.
- The privacy page sends data requests to hi@lnkdrp.com; everything else says support@. Decide
  and align.

### What lnkdrp provides

**Customer cards** — `POST /api/support/plain/customer-cards`
(`src/app/api/support/plain/customer-cards/route.ts`, builders in `src/lib/support/plain/cards.ts`).

When a thread opens, Plain asks for the customer by email and renders what comes back beside the
conversation. Two card keys:

| Key | Shows |
| --- | --- |
| `lnkdrp-account` | Name, sign-up and last-login dates, user id, pending deletion; then one block per workspace: plan (Free / Pro / over-limit grace / blocked), credits and on-demand, documents and projects against the plan caps, members, whether an agent is connected and which client, "Open in admin" link to `/a/data/workspaces/:id`, copy-workspace-id button. |
| `lnkdrp-errors` | The last 5 `ErrorEvent` rows (severity `error`, last 30 days) attributed to the user or any of their workspaces: code, message, route, status, workspace. Link to `/a/errors`. |

Unknown emails get a readable "No lnkdrp account" card, not an error. Unknown card keys get
`components: null`, as Plain's protocol expects.

**Authentication.** Plain signs every request: `Plain-Request-Signature` is the hex HMAC-SHA256
of the raw body, keyed with the workspace's signing secret. The route verifies it before parsing
the body (`src/lib/support/plain/signature.ts`). With `PLAIN_REQUEST_SIGNING_SECRET` unset the
route answers 503 to everything, in every environment.

Setting it up in Plain:

1. **Settings → Request Signing**: copy the secret into `PLAIN_REQUEST_SIGNING_SECRET` (Vercel
   production env, and `.env.local` for a local check).
2. **Settings → Customer Cards → Add card**, twice:
   - Title `lnkdrp account`, key `lnkdrp-account`, URL `https://lnkdrp.com/api/support/plain/customer-cards`, TTL 60 s.
   - Title `Recent errors`, key `lnkdrp-errors`, same URL, TTL 60 s.
   No extra headers are needed; the signature is the auth.
3. Open any thread from a customer with an lnkdrp account. Both cards render in the sidebar.
   Plain caches an integration error for 5 minutes, so fix and wait rather than retrying.

Local check (needs the secret in `.env.local` and a dev-server restart after adding it):

```sh
BODY='{"cardKeys":["lnkdrp-account","lnkdrp-errors"],"customer":{"id":"c_1","email":"someone@example.com","externalId":null}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PLAIN_REQUEST_SIGNING_SECRET" | awk '{print $NF}')
curl -s -X POST http://localhost:3001/api/support/plain/customer-cards \
  -H "content-type: application/json" -H "plain-request-signature: $SIG" -d "$BODY" | jq .
```

Unit tests: `tests/lib/plainCustomerCards.test.ts` (signature door, one card per key, component
vocabulary).

**Chat widget** — `src/components/support/PlainChat.tsx`, mounted once from the root layout when
`NEXT_PUBLIC_PLAIN_CHAT_APP_ID` is set. Who sees what:

| Visitor | Widget |
| --- | --- |
| Signed in | Launcher visible. The server signs their email with `PLAIN_CHAT_SECRET` (`src/lib/support/plain/chat.ts`, hex HMAC-SHA256 of the lower-cased email, Plain's documented recipe), so Plain opens on their own threads and the customer cards render with no verification step. |
| Anonymous on the marketing site | Loaded but hidden. "Talk to us" on pricing and every help article opens it; Plain verifies them by emailed code. |
| Recipient on `/s/…`, `/p/…`, request, download or share-verify routes | Not mounted, and hidden on client-side navigation there. They are a customer's audience, not ours. |

`requireAuthentication: true` is always sent: Plain's "Require email verification" refuses a
widget that does not set it. The signed-in hash is the other accepted proof, so those users still
see no code prompt.

`SupportLink` (`src/components/support/SupportLink.tsx`) is the one way the product points at
support: a `mailto:support@lnkdrp.com` link that opens the widget instead when it is ready. Used by
the dashboard Contact modal, the Pro seats prompt, the pricing Enterprise button and the help
pages. Privacy and Terms keep a plain email address on purpose. Not yet in the account menu.

`/support` (`src/app/support/page.tsx`) always shows the launcher and opens the chat on arrival.
It is the **Chat URL** in Plain's chat settings: the "Reply" button in Plain's unread-message
emails brings the customer there to continue the thread.

Setup in Plain: **Settings → Chat → Create a Chat App**. Set **Chat URL** to
`https://lnkdrp.com/support`. Copy the app id into `NEXT_PUBLIC_PLAIN_CHAT_APP_ID` and generate
the secret on the same page into `PLAIN_CHAT_SECRET`. The app sets no `script-src` CSP, so
nothing else to allow.

**Help articles** — `src/content/help/*.md` (front matter `title` / `description` / `order`),
rendered at `/help` and `/help/:slug` by `src/app/help/*` through
`src/components/help/HelpMarkdown.tsx`, loaded by `src/lib/help/articles.ts`. They live in the
repo, not in Plain's Help Center, because there is no Plain API key on any machine here and
because they change with the product, so they ship in the same commit as the feature they
describe. `src/app/sitemap.ts` lists every public page, the MCP guides and every article;
recipient routes and the signed-in app are deliberately absent. That sitemap is the one knowledge
source the agent needs.

Writing an article: facts only from the product as shipped, checked against `planLimits.ts`,
`schedule.ts`, `packs.ts` and the feature doc; never internal names, paths or flags; nothing
hidden behind a flag or unreleased; link between articles with `/help/<slug>`; second person,
short sentences, 300 to 700 words.

### Not built, on purpose

- No ticketing, threading or inbound mail parsing.
- Feature requests are a tag in Plain, not a board.
- No Claude drafter calling the lnkdrp MCP tools. Later idea, not v1.

### Paste-ready text

`docs/support/plain-setup.md`: the auto-response, the three-block workflow, the agent's custom
instructions, and the template shortlist with the setting to change on each.
