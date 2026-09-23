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

### Not built, on purpose

- No in-app chat widget or contact form yet. `hi@lnkdrp.com` (linked from pricing, privacy,
  terms and the dashboard) forwards into Plain.
- No help-center content in this repo; articles live in Plain's knowledge base so its AI agent
  can answer from them.
- Feature requests are a tag in Plain, not a board.
