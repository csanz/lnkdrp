# Security

This is the map you need before you change anything that decides who may do what.

It exists because lnkdrp is a product whose whole job is handing strangers a URL that serves a
private document. Almost every serious bug found here has been the same shape: a rule that was
right in one place and absent in its twin, or a check made one line too late. The last section of
this document is a catalogue of the ones that actually happened, with the grep that finds the next
one. Read that section even if you skip the rest.

Line references were correct on 2026-09-20. They drift; the symbol names do not. Search by symbol.

---

## 1. Three processes, and what each one holds

Topology is drawn in `DEPLOY.md:186-207`.

### The web app — `lnkdrp.com`, on Vercel

Next.js App Router, `src/app/**`.

**There is no `middleware.ts` in this repo.** Nothing runs in front of `/api/*`. Every handler
gates itself, and a handler that forgets is simply open. This is the single most important fact on
this page; `src/lib/gating/waitlist.ts:10` says it too, because someone assumed otherwise once and
shipped a queue that was a redirect on one React layout.

Reaches MongoDB Atlas (read/write), Vercel Blob, OpenAI, Stripe, Resend, Google OAuth. Holds every
secret in `.env.example`. Sessions are NextAuth JWTs (`src/lib/auth.ts:71-74`). Baseline headers —
`frame-ancestors 'self'`, `nosniff`, `strict-origin-when-cross-origin` — are set at
`next.config.ts:69-77`; HSTS is deliberately absent (`next.config.ts:65`).

Ten cron jobs, schedules in `vercel.json:2-43`, all authenticating through `requireCronAuth`
(`src/lib/cron/auth.ts:74`). `account-purge` is the only one that destroys data
(`DEPLOY.md:705-711`).

### The realtime server — `realtime.lnkdrp.com`, on Fly

`realtime/server.ts`, run from `realtime/Dockerfile`. Not a Vercel function.

Authenticates callers with **one thing**: an HMAC ticket on the query string, checked at the
WebSocket upgrade (`realtime/server.ts:726-732`). No cookies, no keys. Tickets live 60 seconds
(`src/lib/realtime/ticket.ts:12`).

It reads Mongo **change streams only**, on seven collections, and `DEPLOY.md:291-297` requires a
separate read-only Atlas user (`lnkdrp-realtime`) so a leaked Fly secret cannot write. It refuses to
boot without its secret (`realtime/server.ts:66-69`).

**It must never hold `NEXTAUTH_SECRET`** (`DEPLOY.md:250-254`). See §6 for why that matters more
than it looks.

Hardening worth knowing before you change it: sockets die at 60 minutes plus jitter (`:85-86`), 200
sockets per workspace (`:89`), 4 KB max payload (`:724`), 1 MB buffered-bytes drop (`:127`).

> The docstring at `realtime/server.ts:12` says a bad ticket closes with code 4401. The code at
> `:730` writes a raw HTTP 401 on the upgrade socket and destroys it. Trust the code.

### The MCP server — `mcp.lnkdrp.com`, on Fly

`mcp/src/main.ts`, run from `mcp/Dockerfile`.

**It is a translator, not a backend.** It holds no database connection and reaches the app's own
REST API over HTTP (`mcp/README.md:4-6`). Every authorization decision therefore happens in the app,
not here — which is the point, and which is why an MCP tool cannot be more permissive than the route
behind it.

Authenticates with `Authorization: Bearer lnk_…` only (`mcp/src/main.ts:62-67`). A new session
verifies the key against `GET /api/agent/whoami` before doing anything (`:174-179`), and each
session is bound to its key by a constant-time hash compare (`:75-78`, `:155-158`).

Two things that must stay true on a shared host:

- **`NEXTAUTH_SECRET` must not be set.** The deploy gate is `fly secrets list -a lnkdrp-mcp` showing
  exactly `REALTIME_SECRET` and nothing else (`mcp/README.md:468-473`).
- **`LNKDRP_ALLOW_LOCAL_FILES` must not be set.** It turns an agent-supplied absolute path into a
  container filesystem read (`mcp/README.md:103`, `:475-477`).

`LNKDRP_SKIP_CONFIRMATIONS` is honoured only when the API URL is localhost, and otherwise ignored
with a startup warning (`mcp/README.md:104`).

Sessions are in memory, so this needs one instance or sticky routing (`mcp/README.md:127-128`).

Both containers run as `USER node` on a pinned `node:22.23.2-alpine`.

---

## 2. Who can reach a handler

Eight of them. The `Actor` type (`src/lib/gating/actor.ts:300-326`) describes only the first three
— the rest never produce an `Actor` at all, which is exactly why they get forgotten.

| Actor | Resolved by | What it is |
|---|---|---|
| **Signed-in session** | `tryGetSessionClaims` `actor.ts:388-427` | A NextAuth JWT. Disabled and deleted accounts are cut here (`isAccountDisabled:350-375`, called `:421`) — **and only here**; see the note below. |
| **Temp user** | `tryResolveExistingTempActor:591-612`, minted at `resolveActorUncached:634-649` | An anonymous visitor, given headers so the next request is the same person. `kind === "temp"`. Its workspace is always its own personal org. |
| **`lnk_` API key** | `tryResolveApiKeyActor` `apiKeyActor.ts:166-188` | An agent. Resolves to the member who created it, with `viaApiKey` set. Tried **first** in every resolver. Dies if the key is revoked (`:71`) or its creator has left the workspace (`:91`). |
| **Upload secret** | inline, no resolver | `x-upload-secret` — a recipient finishing an upload. Handled by hand in `uploads/[uploadId]/route.ts`, `…/process/route.ts`, `blob/upload/route.ts`. |
| **Internal HMAC** | `verifyInternalProcessToken` `internalProcess.ts:60-75` | The app calling its own processing route. 5-minute TTL, bound to one upload id. |
| **Cron bearer** | `requireCronAuth` `cron/auth.ts:74` | The scheduler. No `Actor`; the route runs as the system. Fails closed in production if no secret is configured (`:97-103`). |
| **Share-link cookie** | `shareLinkUnlocked` `links.ts:159-164` | Proves only "this browser typed this link's password". The link's password hash is inside the HMAC input, so rotating the password kills every cookie (`:155-157`). |
| **Dev/test bypass** | `tryResolveTestBypassActor:571-583` | `API_TEST_BYPASS_AUTH=1`. Returns `null` in production (`:576`). Nothing on the type marks it. |

Three traps live here.

**The upload-secret and internal-HMAC paths synthesise an `Actor` that is indistinguishable from a
real session** (`process/route.ts:896`, `:918`). Only a local boolean — `viaUploadSecret`,
`viaInternal` — and the `PatchCaller` union (`uploads/[uploadId]/route.ts:165`) tell them apart. If
you add a power to that route, ask which callers should have it. A recipient once got to write the
document's own "extracted text", and the AI summarised what they wrote instead of the PDF.

**`resolveActor` mints a temp user when nothing authenticates.** So "is there an actor?" is never a
question worth asking — the answer is yes, always, for a total stranger. And a temp actor's
workspace is its own personal org, which makes `actor.orgId === actor.personalOrgId` true, which
turns on every legacy-widening branch in the codebase. An unauthenticated `GET /api/requests` once
ran a database-wide `updateMany` through exactly this door. Use `resolveExistingActor:681` when you
need "signed in or nothing".

**`isAccountDisabled` is on the JWT path only.** A key-derived actor never passes it. Disabling an
account therefore has to revoke its keys explicitly — `DELETE /api/admin/data/users/:userId` does
this now; it did not before.

Resolver entry points, and the one to pick:

- `resolveActor:661` — cached per request, **mints** a temp user. For public flows.
- `resolveExistingActor:681` — never mints, returns `null` for a stranger. For "must be someone".
- `tryResolveUserActor:478` / `…Fast:518` — key, then session; never temp.
- `tryResolveAuthUserId:435` — JWT claims only, no database, no minting.

---

## 3. The gates

Every one of these answers a question you would otherwise answer by hand, wrongly, in a filter.

**Which row may this actor touch**

| Helper | Question |
|---|---|
| `buildDocMatch` `docs/docMatch.ts:18-36` | Which document may this actor act on? Always excludes `isDeleted`. |
| `liveProjectByIdMatch` `projects/scope.ts:49-65` | The same, for one project by id. |
| `liveProjectFilter` `projects/scope.ts:15-24` | Which projects count for this workspace? Shared by the list and the plan cap so they cannot drift. |

Use these rather than writing the filter. The `allowLegacyByUserId` branch — documents predating
workspaces, which carry no `orgId` — is subtle and is where hand-rolled copies go wrong.

**Who is this, and may they**

| Helper | Question |
|---|---|
| `requireOrgRole` `orgs/requireOrgRole.ts:49-78` | Does this person hold ≥ role in this workspace? `owner > admin > member > viewer`. |
| `forbidUnlessOrgRole` `orgs/requireOrgEditor.ts:19-23` | The route-level wrapper. **Every handler that changes workspace data must call it** — a `viewer` is a read-only seat handed to outside reviewers. |
| `forbidApiKey` `gating/forbidApiKey.ts:34-43` | Is this identity-grade or money-grade work? Keys do document work, never identity work and never billing. |
| `forbidWaitlisted` `gating/waitlist.ts:112-124` | Is this account still queued? Applies to keys too; temp actors are exempt. |
| `requireAdmin` `gating/requireAdmin.ts:41-67` | Staff console. Refuses key-derived actors *before* the role lookup. |
| `isActiveMember` `gating/actor.ts:83-104` | Is this person a member right now? 10-second cache, invalidated by `membershipChanged:217`. |
| `resolveActiveOrgId` `gating/actor.ts:193-215` | Which workspace is this request in? Cookie → stored workspace → JWT claim → personal, each confirmed. `activeOrgCandidateOrder:183-191` is exported so `GET /api/orgs` ranks identically. |

**Recipient-facing**

| Helper | Question |
|---|---|
| `shareLinkUnlocked` `share/links.ts:159-164` | Has this request passed the password gate? Returns `true` for an unprotected link, **so call it unconditionally** — the gate was once lost by wrapping it in an `if`. |
| `isOwnerSideViewer` `share/ownerSide.ts:26-52` | Is this the owner or a teammate? Their opens are recorded and flagged `isOwnerPreview`, never counted. |
| `isBlobStoreHost` `blob/serverClientUploadRoute.ts:215-222` | Is this hostname our Blob store? The SSRF allowlist for every route that dereferences a stored URL. Fails closed in production. |

**Abuse**

| Helper | Question |
|---|---|
| `rateLimit` `http/rateLimit.ts:67` | Mongo-backed so it works across lambdas. Fails open. |
| `guardTempWorkspaceCreation` / `guardApiKeyRequest` `gating/actorRateLimit.ts` | 20 temp workspaces per IP per hour; 300 requests per key per minute — charged per key, not per IP, because every agent shares the MCP's egress address. |

Two combined gates hide the others from a naive grep: `accessDocForLinks`
(`api/docs/[docId]/links/shared.ts:71-116`) and `accessProjectForLinks`
(`api/projects/[projectSlug]/links/shared.ts:43-88`). If a link or shareviews route looks ungated,
it is using one of these.

---

## 4. The public surface

Everything here is reachable with a URL and nothing else. This is the list to re-read whenever you
touch share behaviour.

**Document links** — `/s/:shareId` (page, `pdf`, `changes`, `og.png`). Gate order on the PDF proxy
(`s/[shareId]/pdf/route.ts:306`) is load-bearing: resolve the link → SSRF allowlist → password →
`allowDownload` → owner-side detection → rate limits, all before a counter moves.

**Data rooms** — `/p/:shareId` (page, `:docId` page, `:docId/pdf`, `:docId/preview`). Permissions
come from the **project link, never the document** (`p/[shareId]/[docId]/page.tsx:11-13`). Gate
order is again load-bearing, and for a specific reason: a locked room must answer every candidate
document id identically, or the response shape becomes an inventory of what is inside it.

**Analytics ingest** — `POST /api/share/:shareId/stats`, `POST /api/share/:shareId/landing`. Public
by design and the busiest write path in the product. Both write rows, activity and outbound mail, so
every bound on them matters.

**Unlock** — `POST /api/share/:shareId/unlock`. Three rate-limit buckets: per (IP, link), per link
across every source, per IP across every link, with a failure penalty on the link's budget.

**Request repos** — `/r/:token`, `/request-view/:token`, and the upload APIs behind them. Two
capability tokens, `requestUploadToken` and `requestViewToken`, each a bearer in a URL. Uploading
mints a third capability, an `uploadSecret`, on nothing but the token.

**Replace links** — `/doc/update/:code`, `/replace/:token`. Same shape.

**Download claims** — `/api/download/:token{,/pdf,/save}`. Three gates each: signed in, the account's
email equals the requester's, and the link still resolves and is unlocked.

**Email action links** — approve, deny, unsubscribe. All three are **GET renders, POST writes**,
because corporate link scanners fetch every URL in a message and were approving downloads and
unsubscribing people. Approve and deny additionally carry an HMAC bound to the action word so an
approve confirmation cannot be replayed at deny.

**Other** — `/api/health` (no secrets), `/api/stripe/webhook` (raw-body signature, idempotent by
`StripeEvent.eventId`), `/api/monitor/crons` (read-only secret), `/api/debug` (404 in production
unless admin).

---

## 5. Fail-open and fail-closed, on purpose

These are inconsistent deliberately. Each site carries its own one-line rationale; do not "fix" one
into the other without reading it.

**Fails closed** — `isActiveMember` (`actor.ts:100-103`). Not-confirmed means not confirmed: a blip
drops someone into their own workspace for one request, which is visible and harmless. The
alternative hands out a workspace they may have been removed from.

**Fails open** — `isAccountDisabled` (`:371-374`), `readAccessStatus` (`waitlist.ts:75-78`),
`isOwnerSideViewer` (`ownerSide.ts:48-51`), `rateLimit` (`rateLimit.ts:64-65`). Each of these, on
failure, costs less than refusing every request would. `isOwnerSideViewer` is the clearest: a failed
lookup must not turn a real recipient's view into a dropped one.

---

## 6. Secrets

| Variable | Derivation |
|---|---|
| `NEXTAUTH_SECRET` | **Raw.** The JWT secret, and the fallback behind five other things. |
| `REALTIME_SECRET` | **Always HKDF-derived** (`realtime/ticket.ts:34-36`), even when set explicitly — so all three processes compute the same key from the same input regardless of what else is in their environment. |
| `CRON_SECRET` (internal processing) | HKDF-derived (`internalProcess.ts:47`). |
| `LNKDRP_NOTIFICATION_TOKEN_SECRET` | Mixed, deliberately: a distinct configured secret is used verbatim; absent, the key is HKDF-derived **and the raw master is kept as a verify-only legacy key** so unsubscribe links already in mailboxes survive their 30-day TTL (`viewEmailToken.ts:102-126`). |
| `LNKDRP_SHARE_PASSWORD_SECRET` | Raw for the cookie HMAC; `sha256(secret)` as the AES key. **Rotating it makes every stored share password undecryptable** — it needs a dual-read migration, not a swap. |
| `LNKDRP_ORG_INVITE_TOKEN_SECRET` | Same shape, same warning. |
| `CRON_SECRET`, `CRON_MONITOR_SECRET`, `STRIPE_WEBHOOK_SECRET` | Raw, constant-time compared. |
| `BLOB_READ_WRITE_TOKEN` | Not a signing key, but the store id is parsed out of it and becomes the SSRF allowlist host for five public proxies. |

**The rule, stated once.** `NEXTAUTH_SECRET` is the fallback behind session cookies, the AES key over
every stored share password, the AES key over org invite tokens, view-notification tokens and the
internal processing HMAC. **A process that holds it holds all five.** That is the entire reason the
realtime and MCP hosts are forbidden from having it, and why new secrets derive a purpose-bound key
rather than using the master value.

If you add a signed or encrypted artifact, derive: `hkdfSync("sha256", material, "<purpose-salt>",
"<purpose-info>:v1", 32)`. Copy `src/lib/realtime/ticket.ts`.

---

## 7. The bugs that actually happened

Every one of these was found here, more than once, and all are fixed. This is the section to read
before an audit — it tells you what to grep for.

**1. A `$or` written twice.** A Mongo filter is a JavaScript object literal, so a key declared twice
keeps only the last one. Several routes spread a tenancy clause that is a `$or` and then wrote a
second `$or` beside it. The query runs with *fewer* bounds than the code reads as having, and a
query with fewer bounds returns more rows, confidently, with no error anywhere.
→ *Grep:* a `...(allowLegacyByUserId ? { $or: [...] } : { orgId })` spread with a sibling `$or:` key.
→ *Fix:* `$and`, or call the shared match helper so there is no second key to lose.

**2. The check made after the fetch.** `findOne({ _id })`, then an `if` about ownership. The bound
belongs in the query. A rule applied afterwards is a rule the next caller of that function will not
get.

**3. A fail-open conjunct.** `if (params.orgId && doc.orgId && String(doc.orgId) !== String(params.orgId))`
— `doc.orgId` is nullable, so every legacy row skipped the comparison entirely.
→ *Grep:* an optional field in the middle of an authorization test.

**4. A side-effecting GET on a URL that lives in an email.** Safe Links, Proofpoint, Mimecast and
every prefetching client fetch the links in a message. Approve, deny and unsubscribe all did their
work on sight.
→ *Rule:* if the URL is in an email body, GET renders and POST writes. Keep the emailed URL valid.

**5. A control that was built and never called.** The viewer-verification sender had zero callers,
so its token, its `/share/verify` page and its whole premise were unreachable — while the code that
depended on "a verified address" behaved as if verification existed.
→ *Grep:* exported functions with no call site outside their own file.

**6. A bound keyed on something the caller rotates.** The confirmation mail was bounded per email
address; an attacker supplies a new address each request. The new-reader ceiling was charged per
created row; on a project link a row is (viewer, document), so a ten-file room burned it ten times
faster than intended.
→ *Ask:* what part of this key is chosen by the caller?

**7. A gate on one route and not its twin.** `/s/:shareId/pdf` and `/p/:shareId/:docId/pdf` are
near-identical files. The data-room oracle had **three** doors — the page, the PDF proxy, and the
analytics ingest — and the first two fixes looked complete.
→ *Rule:* after fixing a public route, find its sibling and its API equivalent.

**8. A response-shape oracle in front of a gate.** A password-protected room answered 404 for a
document id outside it and 200 for one inside. That sorts guessed ids into "in this room" and "not",
which is precisely what the password withholds.
→ *Rule:* behind a gate, every candidate must get a byte-identical answer, and the membership
lookup must not even run.

**9. Trusting a caller-supplied dedupe key.** `visitId` came off the request body and was the only
thing deduplicating visit counts.

**10. A redirect used as enforcement.** The early-access queue was a `redirect()` in one React
layout. The account was real and signed in, and every API route answered it normally.
→ *Rule:* a page-level check is a courtesy to the person using the UI. The gate is in the handler.

**11. An absent field reads as permissive.** `{ isOwnerPreview: { $ne: true } }` matches a row where
the field was never written. A route that forgot to stamp it produced rows that counted as
recipients forever.
→ *Rule:* write the flag explicitly, including when it is `false`.

**12. A secret reused for a second purpose.** See §6.

**13. Searching by a field you refuse to return.** The admin routes stopped returning `shareId` and
still matched `?q=` against it with an unanchored regex, while returning per-row identity and a
total. That is character-by-character extraction: about twelve rounds of sixty-two requests for a
base62 slug.
→ *Rule:* a redacted field may be matched by equality, never by substring.

**14. A capability with no revocation.** Request-repo tokens could not be rotated; API keys outlived
their owner's account; an invite was never compared to the address it was sent to.
→ *Ask, for every token:* who can withdraw it, and what happens to it when its holder leaves?

---

## 8. Before you ship a handler

- Which actors can reach it? All eight in §2, not just the one you had in mind.
- Does it call `forbidUnlessOrgRole`? Anything that changes workspace data must.
- Should a `lnk_` key be able to do this? If it is about identity, access or money — `forbidApiKey`.
- Is the tenancy bound **in the query**, via `buildDocMatch` / `liveProjectByIdMatch`?
- Does it write? Then it is a POST, and if its URL can appear in an email, GET renders a button.
- Does it dereference a stored URL? `isBlobStoreHost`.
- Does it cause outbound mail? What bounds it that the caller cannot rotate?
- Does it answer differently for a resource that exists and one that does not — *before* the gate?
- Is there a sibling route with the same shape? Fix it now; you will not come back.

Tests live in `tests/lib/`, run with
`npx vitest run --config tests/lib/vitest.config.ts <file>` (that config supplies the `@` alias; the
default one does not). The house style is to assert on the **filter the handler issues**, not the
response body — the rule lives in the query. See `tests/lib/crossTenantScoping.test.ts` and
`tests/lib/duplicateOrTenancy.test.ts`.

**Check that a new test fails against the old code.** Revert your change, run it, watch it go red,
put it back. Several tests in this repo passed for reasons other than the one they claimed until
this was done.

---

## 9. Known open

- **Public blob URLs.** Page images and the full extracted text of every PDF live at paths that are
  a pure function of `(docId, uploadId)`, written `access: "public"` with no random suffix, and
  nothing consults the link's state before the blob store serves them. One preview URL, handed to a
  recipient by a page that is working as designed, spells out both ids — and every other artifact
  hangs off the same prefix. This is the one finding from the 2026-09-20 review still live. It needs
  signed URLs or a proxy in front of the store; it is not a patch.
- **One route still holds a local copy of the blob allowlist.** `fetchStoredBlob`
  (`src/lib/blob/fetchStoredBlob.ts`) is the one place that validates a stored URL and follows its
  redirects, re-checking the host on every hop. Four of the five call sites use it;
  `/p/:shareId/:docId/preview` still carries its own predicate and a bare `fetch`, so it remains a
  redirect-follower until it is converted.
- ~~No audit of already-stored URLs.~~ **Answered.** `npm run audit:blob-urls`
  (`scripts/audit-stored-blob-urls.ts`) walks every document and upload and reports any value the
  serving path would refuse, asking `blobFetchUrl` rather than re-deriving the rule. Read-only,
  exit 1 on a finding. First run on the development database: 117 documents, zero off the store.
  Run it against production before trusting that sentence there too.
- **Invite email mismatch has no designed screen.** The refusal is correct; the copy is generic.
- **`REALTIME_SECRET` is not required in production.** The ticket key is derived either way, so a
  single-secret deploy works; making it mandatory is an ops decision.

---

## 10. Where things are

| | |
|---|---|
| Actors and workspace resolution | `src/lib/gating/actor.ts` |
| API keys | `src/lib/gating/apiKeyActor.ts`, `src/lib/agents/apiKeys.ts` |
| Roles | `src/lib/orgs/requireOrgRole.ts`, `src/lib/orgs/requireOrgEditor.ts` |
| Row scoping | `src/lib/docs/docMatch.ts`, `src/lib/projects/scope.ts` |
| Share links and refusals | `src/lib/share/links.ts`, `src/lib/share/projectLinks.ts` |
| Share passwords | `src/lib/sharePassword.ts` |
| Blob allowlist | `src/lib/blob/serverClientUploadRoute.ts` |
| Rate limiting | `src/lib/http/rateLimit.ts`, `src/lib/gating/actorRateLimit.ts` |
| Realtime tickets | `src/lib/realtime/ticket.ts` |
| Cron auth | `src/lib/cron/auth.ts` |
| Admin redaction | `src/lib/admin/docPrivacy.ts` |
| Deployment, secrets, rotation | `DEPLOY.md` |
| MCP specifics | `mcp/README.md`, `docs/MCP.md` |
