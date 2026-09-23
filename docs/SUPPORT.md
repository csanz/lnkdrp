## Customer support (Plain)

Support runs in [Plain](https://plain.com). lnkdrp does not host an inbox, ticketing or a help
widget; it feeds Plain the context a ticket needs and links back into the admin area.

Decision (2026-09-23): buy the inbox, build only the glue. See the memory note
`customer-support-plain` for the reasoning against building our own.

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

### Authentication

Plain signs every request: `Plain-Request-Signature` is the hex HMAC-SHA256 of the raw body,
keyed with the workspace's signing secret. The route verifies it before parsing the body
(`src/lib/support/plain/signature.ts`). With `PLAIN_REQUEST_SIGNING_SECRET` unset the route
answers 503 to everything, in every environment.

### Setting it up in Plain

1. **Settings → Request Signing**: copy the secret into `PLAIN_REQUEST_SIGNING_SECRET` (Vercel
   production env, and `.env.local` for a local check).
2. **Settings → Customer Cards → Add card**, twice:
   - Title `lnkdrp account`, key `lnkdrp-account`, URL `https://lnkdrp.com/api/support/plain/customer-cards`, TTL 60 s.
   - Title `Recent errors`, key `lnkdrp-errors`, same URL, TTL 60 s.
   No extra headers are needed; the signature is the auth.
3. Open any thread from a customer with an lnkdrp account. Both cards render in the sidebar.
   Plain caches an integration error for 5 minutes, so fix and wait rather than retrying.

### Local check

Sign a body the way Plain does and post it to the dev server (needs the secret in `.env.local`
and a dev-server restart after adding it):

```sh
BODY='{"cardKeys":["lnkdrp-account","lnkdrp-errors"],"customer":{"id":"c_1","email":"someone@example.com","externalId":null}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PLAIN_REQUEST_SIGNING_SECRET" | awk '{print $NF}')
curl -s -X POST http://localhost:3001/api/support/plain/customer-cards \
  -H "content-type: application/json" -H "plain-request-signature: $SIG" -d "$BODY" | jq .
```

Unit tests: `tests/lib/plainCustomerCards.test.ts` (signature door, one card per key, component
vocabulary).

### Chat widget

`src/components/support/PlainChat.tsx`, mounted once from the root layout when
`NEXT_PUBLIC_PLAIN_CHAT_APP_ID` is set. Who sees what:

| Visitor | Widget |
| --- | --- |
| Signed in | Launcher visible. The server signs their email with `PLAIN_CHAT_SECRET` (`src/lib/support/plain/chat.ts`), so Plain opens on their own threads and the customer cards render with no verification step. |
| Anonymous on the marketing site | Loaded but hidden. "Talk to us" on pricing opens it; Plain verifies them by emailed code. |
| Recipient on `/s/…`, `/p/…`, request, download or share-verify routes | Not mounted, and hidden on client-side navigation there. They are a customer's audience, not ours. |

`SupportLink` (`src/components/support/SupportLink.tsx`) is the one way the product points at
support: a `mailto:support@lnkdrp.com` link that opens the widget instead when it is ready. Used by
the dashboard Contact modal, the Pro seats prompt and the pricing Enterprise button. Privacy and
Terms keep a plain email address on purpose.

`/support` (`src/app/support/page.tsx`) always shows the launcher and opens the chat on arrival.
It is the **Chat URL** in Plain's chat settings: the "Reply" button in Plain's unread-message
emails brings the customer there to continue the thread.

Setup in Plain: **Settings → Chat → Create a Chat App**. Set **Chat URL** to
`https://lnkdrp.com/support`. Copy the app id into
`NEXT_PUBLIC_PLAIN_CHAT_APP_ID` and generate the secret on the same page into
`PLAIN_CHAT_SECRET`. The app sets no `script-src` CSP, so nothing else to allow.

### Not built, on purpose

- No help-center content in this repo; articles live in Plain's knowledge base so its AI agent
  can answer from them.
- Feature requests are a tag in Plain, not a board.

### Help articles and the AI agent (Ari)

Customer-facing help lives in the repo, not in Plain: `src/content/help/*.md` (front matter
`title` / `description` / `order`), rendered at `/help` and `/help/:slug` by
`src/app/help/*` through `src/components/help/HelpMarkdown.tsx`, loaded by
`src/lib/help/articles.ts`. They change with the product, so they ship in the same commit as the
feature they describe. `src/app/sitemap.ts` lists every public page, the MCP guides and every
article; recipient routes and the signed-in app are deliberately absent.

Setup in Plain, once the branch is deployed (Ari can only index pages it can fetch):

1. **Settings → Plain AI → Knowledge Sources → Sitemap**: `https://lnkdrp.com/sitemap.xml`.
   New articles are indexed on the next crawl with no step in Plain.
2. **Workflows → routing rule**: condition channel is chat (add email once the articles have
   proven themselves), action "Assign to user" with Ari.
3. **Ari → Preferences**: Shadow mode first; switch to Live when the drafts read right.
4. **Settings → Auto-responses**: one for new threads, a minute's delay, so a customer sees an
   acknowledgement even before Ari or a person answers.

Writing an article: facts only from the product as shipped; never internal names, paths or
flags; nothing hidden behind a flag or unreleased; link between articles with `/help/<slug>`.

The paste-ready text for the auto-response, the Ari routing rule, Ari's custom instructions and
the template shortlist is in `docs/support/plain-setup.md`.
