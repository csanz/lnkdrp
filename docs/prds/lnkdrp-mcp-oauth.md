# PRD — OAuth for the MCP server

**Status:** Implemented 2026-09-24 (M1–M3, on `next-release`, untested against a live client until the MCP is hosted). M4: CORS on `/mcp` is an origin allow-list (`MCP_CORS_ORIGINS`, 2026-09-24); per-client limits reuse the per-key ceiling keyed on the grant id; the shared session store is not started. See the review and the implementation note at the end.
**Owner:** chrissanz
**Last updated:** 2026-09-24
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-mcp](./lnkdrp-mcp.md) · [lnkdrp-enterprise](./lnkdrp-enterprise.md)

---

## Problem

`mcp.lnkdrp.com` authenticates with a raw API key in an `Authorization: Bearer` header. That works
for every client where a human can paste a key into a config file, and for nothing else.

The server answers an unauthenticated request with a spec-correct 401 and a `WWW-Authenticate`
pointing at `/.well-known/oauth-protected-resource`. That document says:

```json
{ "resource": "https://mcp.lnkdrp.com", "authorization_servers": [], "bearer_methods_supported": ["header"] }
```

`authorization_servers: []` is the whole problem. A client that follows the MCP authorization spec
discovers the metadata, finds no authorization server, and has nowhere to send its user. It cannot
resolve this by retrying or re-authorising, because there is nothing to authorise against. To the
person watching, it reads as "cannot connect" — a network fault, which it is not.

So the product today divides clients in two:

- **Connects:** Claude Code, Cursor, Codex, Gemini CLI, Grok, Cowork — anything that lets a human
  set a request header. These are what `/connect` generates snippets for.
- **Cannot connect:** any client that authenticates by OAuth on the user's behalf, which is the
  direction hosted and first-party connectors have gone.

A second, smaller wall sits behind the first: the server sends no CORS headers, so a client calling
from a browser origin is refused before auth is even reached.

Shipping decision (owner, 2026-09-20): **launch with header auth**, scope this immediately after.
Nothing here is a launch blocker; all of it is what turns "our MCP works if you are a developer
with a config file" into "our MCP works".

## Goals

1. A user adds lnkdrp to an OAuth-capable client by clicking through a consent screen, never
   handling a key.
2. An OAuth token maps to exactly the same thing an `lnk_…` key maps to today — one workspace, one
   acting user, the same scopes — so every tool, gate and activity row works unchanged.
3. Existing API keys keep working, indefinitely. This adds a way in; it does not close one.
4. A revoked authorisation stops working as fast as a revoked key does.

## Non-goals

- Replacing API keys. Headless and CI callers want a static credential, and `--stdio` has no
  browser to redirect to.
- Per-tool scopes. The current `read` / `write` split is what the tools check; a finer model is a
  separate decision.
- Being an identity provider for anything other than this MCP server.

## The shape of the work

Five pieces. The order matters: each is testable on its own, and the first two are most of the risk.

### 1. Decide where the authorization server lives

Two options, and this decision drives everything below.

- **The Next app is the authorization server.** It already owns sessions, users, workspaces and the
  key model; `/connect` is already the page that issues credentials. The MCP server stays a resource
  server that validates tokens. Most code lands in `src/app/api/oauth/**`.
- **A third-party IdP.** Less to build and to get wrong, but it has to be taught the workspace model
  before a token can mean "this user, in this workspace", which is the part that actually matters.

Recommendation: the Next app, because the hard part is not the protocol, it is mapping a token to a
workspace — and that mapping already exists there.

### 2. The endpoints

- `/.well-known/oauth-authorization-server` — authorization server metadata (RFC 8414).
- `/.well-known/oauth-protected-resource` on the MCP host — the existing document, with
  `authorization_servers` finally populated. It already carries `resource_documentation` pointing at
  `/connect`.
- `POST /oauth/register` — **dynamic client registration (RFC 7591)**. Not optional: hosted clients
  register themselves rather than asking a human to pre-create a client id.
- `GET /oauth/authorize` — the consent screen. Signed-in user, a plain sentence about what the agent
  will be able to do, and **a workspace picker**, since a user can belong to several and the token
  has to name one.
- `POST /oauth/token` — code exchange and refresh. PKCE required (S256).
- `POST /oauth/revoke` — RFC 7009, and the same revocation surface the keys page already has.

### 3. The token, and what it maps to

The MCP server resolves a bearer today by calling the app's own key-verification path and caching
the resulting workspace. An OAuth access token has to land in the same place: `{ userId, orgId,
scopes, clientName }`. If the token is a signed JWT the MCP can validate it locally; if it is
opaque, the MCP introspects it (RFC 7662) and caches on the same 1s throttle the key path uses.

Prefer opaque + introspection for v1. Revocation is the requirement that decides it: a JWT stays
valid until it expires, and "I removed that agent" has to mean it stops working now.

### 4. CORS

A browser-origin client cannot reach the server at all today. Once OAuth exists this becomes the
next wall, so it lands with it: an allow-list of origins, `Authorization` and `Mcp-Session-Id` in
`Access-Control-Allow-Headers`, `Mcp-Session-Id` exposed, preflight answered on `/mcp`. Not
`*` — the endpoint is credential-bearing.

### 5. Surfacing it

`/connect` gains the other half: today it only mints keys. It should show authorised agents
alongside keys, with the same revoke button, because a user will not distinguish "a key" from "an
agent I connected" and should not have to.

## Open questions

1. **Token lifetime.** Short access tokens plus refresh is correct and means a long-lived agent
   must handle refresh. What happens to an in-flight MCP session when the token expires — does the
   session survive on the strength of having been authenticated once, or must it re-auth mid-run?
2. **Workspace switching.** A token names one workspace. Does a user with three workspaces connect
   three times, or does one authorisation carry a workspace the client can change per call? The
   current one-connection-per-workspace model (`lnkdrp-usavx`, `lnkdrp-personal`) says three.
3. **Consent copy.** The screen has to say what an agent can do in terms a person can act on —
   "read your documents and analytics, create and revoke share links, upload and replace PDFs,
   delete documents" — without becoming a permissions wall nobody reads.
4. **Sessions and horizontal scale.** The MCP is pinned to one machine because sessions are
   in memory. OAuth does not change that, but a connector-driven increase in connected agents makes
   it bite sooner. Worth deciding whether a shared session store lands with this or before it.
5. **Rate limiting per client.** A registered client is a new unit to limit by, and DCR means
   anyone can create one.

## Milestones

- **M1 — Decide and skeleton.** Section 1 settled, metadata documents served from both hosts,
  `authorization_servers` populated, nothing else works yet. A client gets as far as discovery.
- **M2 — The flow.** DCR, authorize with the workspace picker, token with PKCE, opaque tokens with
  introspection from the MCP. A real client connects end to end.
- **M3 — Revocation and management.** `/oauth/revoke`, authorised agents on `/connect`, activity
  rows for connect and revoke — matching what `agent.key_created` / `agent.key_revoked` already do.
- **M4 — CORS and hardening.** Origin allow-list, preflight, per-client rate limits, and the
  session-store decision from open question 4.

## What exists already, and is worth not rebuilding

- `src/lib/agents/apiKeys.ts` — creation, hashing, scopes, revocation. An OAuth token is another
  credential shape over the same concepts.
- `mcp/src/main.ts` — bearer extraction, session-to-key binding (`sameKey`), the 401 path, and the
  resource metadata document. The seam for a second credential type is where `bearerFrom` decides a
  token is an API key by its `lnk_` prefix.
- `/connect` and `src/lib/mcp/clientSetups.ts` — the page and the per-client instructions, which
  gain a second path rather than being replaced.
- `agent.connected`, `agent.key_created`, `agent.key_revoked` activity types already exist and are
  the right vocabulary for authorisations too.

## Review, 2026-09-24

Read against the code as it stands. The PRD holds; four things sharpen it.

**1. The authorization server goes in the Next app, and the reason is stronger than the PRD says.**
The MCP server never verifies a credential itself: it forwards the caller's bearer on every REST
call and the app's `verifyBearer` (`src/lib/gating/apiKeyActor.ts`) is the single verifier. So an
OAuth access token is only a second token shape that function accepts, and the "introspection
vs JWT" question in section 3 dissolves: the app looks the token up the same way it looks a key
up, and revocation is immediate for free. The MCP server changes are two lines: `bearerFrom` in
`mcp/src/main.ts` stops requiring the `lnk_` prefix, and the well-known document lists
`https://www.lnkdrp.com` under `authorization_servers`.

**2. Do not use the SDK's OAuth server router.** `@modelcontextprotocol/sdk` ships
`server/auth` (DCR, authorize, token, revoke handlers behind an `OAuthServerProvider`), but it is
Express middleware for the MCP process, which has no database and no user session. The consent
screen has to live where the sign-in cookie lives. Reuse only `shared/auth` (the request schemas)
from the Next app's routes.

**3. What to build, by file.**
- `src/lib/models/OAuthClient.ts`: id, name, redirect URIs, created via DCR.
- `src/lib/models/OAuthGrant.ts`: one row per authorisation = `{ userId, orgId, scopes, clientId,
  accessHash, accessExpiresAt, refreshHash, revokedAt }`. Tokens opaque, prefix `lnko_`, sha256
  like keys. Access 1 h, refresh 30 d, refresh rotates.
- `src/app/.well-known/oauth-authorization-server/route.ts` (RFC 8414 metadata).
- `src/app/api/oauth/register/route.ts` (RFC 7591; only `https` or loopback redirect URIs; rate
  limited by IP because anyone may call it).
- `src/app/connect/authorize/page.tsx`: signed-in consent with the workspace picker, plain
  sentence of what the agent can do, CSRF-bound, then redirect with `code` + `state`. Codes are
  one-use, 5 min, bound to the PKCE challenge and the `resource`.
- `src/app/api/oauth/token/route.ts`: `authorization_code` with PKCE S256, and `refresh_token`.
- `src/app/api/oauth/revoke/route.ts` (RFC 7009), plus the grant listed on `/connect` next to the
  keys with the same Revoke button, writing `agent.connected` / `agent.key_revoked` activity.
- `verifyBearer`: `lnk_` → key path as today; `lnko_` → grant lookup → the same `Actor`.

**4. One real change inside the MCP server: session binding.** A session is bound to the sha256
of the bearer that opened it (`sameKey`). An OAuth client rotates its access token every hour, so
the next request after a refresh would be refused as a different credential. Bind sessions to a
stable id returned by the app (the grant id, or the key id) rather than to the token hash.

**Clients this unlocks.** Claude Code already does this flow natively (`claude mcp add --transport
http`, then `/mcp` to sign in), as do Cursor, Codex CLI and Gemini CLI. The larger gain is the
clients that cannot set a header at all: Claude.ai and Claude Desktop connectors, ChatGPT
connectors, Cowork. Today `/connect` cannot serve any of them.

**Effort.** M1 + M2 about three days, M3 one day, CORS half a day. Nothing new to deploy.

**Blocker that is not this PRD.** `mcp.lnkdrp.com` does not resolve (checked 2026-09-24). OAuth
is worthless until the server is hosted; `deploy/fly/mcp.fly.toml` and `DEPLOY.md` section 7 are
ready for that. Host first, then this.

## Implementation note, 2026-09-24

Built as the review describes. Files: `src/lib/agents/oauth.ts` (the library and the map of the
flow), `oauthHttp.ts`, `oauthAuthorize.ts`, models `OAuthClient` / `OAuthCode` / `OAuthGrant`,
routes under `src/app/api/oauth/*`, the consent page `src/app/connect/authorize/page.tsx`, the
metadata document `src/app/.well-known/oauth-authorization-server/route.ts`; `verifyBearer` accepts
`lnko_` tokens; whoami returns `credentialId`; `mcp/src/main.ts` names the app as authorization
server and rebinds a session across token refresh; grants list on `/connect` beside keys with one
Revoke. `docs/MCP.md` "Signing in instead of a key" is the operator-facing description.

Open questions from above, as decided: (1) an in-flight session survives a refresh because the
binding is the grant id, not the token; (2) one grant names one workspace, chosen on the consent
screen, so a second workspace is a second connection, as with keys; (3) consent copy is two bullets
per scope in the person's terms; (4) unchanged, single machine; (5) DCR is rate limited per address
(20/hour), per-client request limits reuse the per-key ceiling keyed on the grant id.

Untested against a real client until `mcp.lnkdrp.com` is up: the first live run should be
Claude Code (`claude mcp add --transport http lnkdrp https://mcp.lnkdrp.com/mcp`, then `/mcp`).
