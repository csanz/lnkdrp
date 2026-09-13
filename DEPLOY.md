# Deploying lnkdrp

This is the runbook for taking lnkdrp from `main` to production and keeping it there. It covers
the three deployable pieces, the managed services they depend on, the exact environment each
one needs, the order to bring them up, how to verify a release, and how to roll one back.

The older first-deployment checklist with key-generation walkthroughs lives in
`docs/deploy/Deploy_1.md`; this file is the source of truth and links to it where useful.

## 1. Topology

```
                     ┌──────────────────────────────────────────────┐
  browser / agent ─▶ │  lnkdrp.com  · Next.js on Vercel             │ ─▶ MongoDB Atlas (replica set)
                     │  web app + REST API + 7 cron routes          │ ─▶ Vercel Blob (PDF storage)
                     └───────────────┬──────────────────────────────┘ ─▶ OpenAI (summary, AI compare)
                                     │ REST with the caller's lnk_ key  ─▶ Stripe (Pro + on-demand credits)
                                     │                                  ─▶ Google OAuth (sign-in)
  MCP client ──────▶ mcp.lnkdrp.com  · Node service (mcp/)  ───────────┘
                     thin translator; no database access

  browser ─────────▶ realtime.lnkdrp.com · Node service (realtime/)  ─▶ MongoDB change streams
  MCP server ──────▶ WebSocket rooms per workspace, HMAC tickets
```

| Piece | Runs on | Why it lives there |
|---|---|---|
| Web app + API + crons | Vercel | Serverless functions, Vercel Cron, Blob client uploads |
| Realtime server | Any host that holds sockets (Fly, Railway, a VM, Docker) | Vercel functions cannot keep a WebSocket open |
| MCP server | Same kind of host, or the same box as realtime | Long-lived MCP sessions; holds client identity per session |

All three share one Mongo cluster and one secret family. Nothing else is stateful.

## 2. Prerequisites

- **MongoDB Atlas** cluster, M10 or larger for change streams under load (M0 works for a
  smoke test). It must be a replica set; Atlas always is.
- **Vercel** project connected to this repository, Node 22 runtime (declared in
  `package.json` `engines`).
- **Stripe** live account with the catalog from section 4.
- **Google Cloud** OAuth client for sign-in.
- **Vercel Blob** store.
- **OpenAI** API key.
- DNS control for `lnkdrp.com`, `mcp.lnkdrp.com`, `realtime.lnkdrp.com`.
- A machine with Docker for the two services, or an account on a container host.

## 3. Secrets

Generate once, store in a password manager, paste into each service's env:

```
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -hex 32      # CRON_SECRET
openssl rand -hex 32      # REALTIME_SECRET   (shared by web app, realtime, mcp)
```

`LNKDRP_SHARE_PASSWORD_SECRET` and `LNKDRP_ORG_INVITE_TOKEN_SECRET` fall back to
`NEXTAUTH_SECRET`; set them separately only if you want independent rotation.

## 4. Managed services, in order

### 4.1 MongoDB Atlas

1. Create the cluster and a database user with read/write on `lnkdrp`.
2. Network access: allow Vercel's egress (or `0.0.0.0/0` with a strong password, which is what
   Vercel recommends) and the static IP of the services host.
3. Copy the `mongodb+srv://…/lnkdrp` URI. This is `MONGODB_URI` for all three pieces.
4. Run migrations from a trusted machine with that URI in the environment:
   ```
   MONGODB_URI='mongodb+srv://…' node db/migration/run.mjs --dry-run
   MONGODB_URI='mongodb+srv://…' node db/migration/run.mjs
   ```
   Migrations create indexes only; they are idempotent and safe to re-run.

### 4.2 Stripe (live mode)

Mirror the sandbox catalog, which is already correct. Ids for the sandbox are in
`docs/SUBSCRIPTION.md`; the live ones will differ.

1. Product **Pro** with one recurring licensed price: $29 / month. Description:
   "Unlimited share links and projects, deep viewer analytics, version history with AI compare,
   1 collaborator included, and 300 AI credits a month (about 60 standard AI compares).
   Summaries never use credits." No unit label.
2. Billing Meter **AI credits (on-demand)**: event name `ai_credits`, aggregation sum, customer
   mapped by `stripe_customer_id`, value key `value`.
3. Product **On-demand AI credits** with one metered monthly price at $0.10 per unit on that
   meter, unit label `credit`. Metadata `type=ai_credits`. This price is attached to every Pro
   subscription at checkout; the app reports one meter unit per credit only when a workspace has
   turned on-demand on.
4. Webhook endpoint `https://lnkdrp.com/api/stripe/webhook` with these events:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
5. Customer portal: enable cancel and payment-method update; return URL `https://lnkdrp.com/dashboard`.
6. Env: `STRIPE_SECRET_KEY` (sk_live), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID`
   (the $29 price), `STRIPE_AI_CREDITS_PRICE_ID` (the $0.10 price), `STRIPE_CREDITS_METER_EVENT_NAME=ai_credits`.

Keep the sandbox for the preview environment; never point a preview at live keys.

### 4.3 Google OAuth

Web client with authorised redirect URI `https://lnkdrp.com/api/auth/callback/google`, and
`https://<preview-domain>/api/auth/callback/google` for previews if you want sign-in there.
Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Anyone with a Google account can sign in;
there are no invite codes.

### 4.4 Vercel Blob

Create a store in the Vercel project, copy `BLOB_READ_WRITE_TOKEN`. Uploads go browser → Blob
with a server-issued token; the completion callback reaches the app at the public site URL, so
`VERCEL_BLOB_CALLBACK_URL` is only needed when the app is not reachable there (local tunnels).

### 4.5 OpenAI

`OPENAI_API_KEY`. All tiers currently use `gpt-4o-mini`; the tier changes depth, not model.

## 5. Web app on Vercel

1. Import the repository; framework preset Next.js; root directory `/`; Node 22.
2. Domains: `lnkdrp.com` (primary) and `www.lnkdrp.com` redirecting to it.
3. Environment variables (Production). Required unless marked optional:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://lnkdrp.com` |
| `NEXTAUTH_URL` | `https://lnkdrp.com` |
| `NEXTAUTH_SECRET` | generated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from 4.3 |
| `MONGODB_URI` | from 4.1 |
| `BLOB_READ_WRITE_TOKEN` | from 4.4 |
| `OPENAI_API_KEY` | from 4.5 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_AI_CREDITS_PRICE_ID`, `STRIPE_CREDITS_METER_EVENT_NAME`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | from 4.2 |
| `CRON_SECRET` | generated; Vercel Cron sends it as `Authorization: Bearer` automatically |
| `REALTIME_SECRET` | generated; same value on the services host |
| `NEXT_PUBLIC_REALTIME_URL` | `wss://realtime.lnkdrp.com` (leave unset until section 6 is live; the app polls meanwhile) |
| `NOTIFICATION_EMAIL_FROM` | `LinkDrop <hi@lnkdrp.com>` plus the email transport settings in `docs/DEV.md` |
| `LNKDRP_SHARE_PASSWORD_SECRET`, `LNKDRP_ORG_INVITE_TOKEN_SECRET` | optional |
| `NEXT_PUBLIC_MCP_URL` | optional; default already `https://mcp.lnkdrp.com/mcp` |

Never set `API_TEST_BYPASS_AUTH` or `ADMIN_LOCALHOST_BYPASS` in production. The code refuses
the auth bypass outside development, but do not rely on that.

4. Crons come from `vercel.json` (seven routes, hourly to six-hourly). Each cron route also
   accepts `POST` with the same bearer for manual runs. Vercel Pro is required for schedules
   more frequent than daily; the notification-emails cron runs every 5 minutes.
5. Deploy. The first production build takes a few minutes because of the PDF and canvas native
   packages.

## 6. Realtime server

Host it anywhere that can keep a WebSocket open and reach Atlas. Single instance for launch.

```
docker build -f realtime/Dockerfile -t lnkdrp-realtime .
docker run -d --restart unless-stopped -p 8788:8788 \
  -e MONGODB_URI='mongodb+srv://…' -e REALTIME_SECRET='…' lnkdrp-realtime
```

Or with the compose file that runs both services: `docker compose -f deploy/docker-compose.yml up -d --build`.

1. Put TLS in front (Caddy, nginx, the host's load balancer) so the public address is
   `wss://realtime.lnkdrp.com`. WebSocket upgrade must be passed through; idle timeouts should
   exceed 30 seconds (the server pings every 25).
2. `GET https://realtime.lnkdrp.com/healthz` → `{ ok: true, rooms, sockets }`.
3. Set `NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com` in Vercel and redeploy the web app.
   Until then the app polls and everything still works.

Details, frame formats and scaling notes: `docs/REALTIME.md`.

## 7. MCP server

```
docker build -f mcp/Dockerfile -t lnkdrp-mcp .
docker run -d --restart unless-stopped -p 8787:8787 \
  -e NODE_ENV=production -e LNKDRP_API_URL=https://lnkdrp.com \
  -e MCP_PUBLIC_URL=https://mcp.lnkdrp.com \
  -e NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com -e REALTIME_SECRET='…' \
  lnkdrp-mcp
```

1. TLS in front so clients reach `https://mcp.lnkdrp.com/mcp`. Sessions are held in memory,
   so run one instance or use sticky sessions on `Mcp-Session-Id`.
2. `GET https://mcp.lnkdrp.com/healthz` → `{ ok: true, sessions, version, apiUrl }`.
3. The public guides at `https://lnkdrp.com/mcp/<client>` already point clients here.

The server has no database access: every tool call is a REST call to the web app with the
caller's own key. Details: `docs/MCP.md`.

## 8. Verify the release

Run in this order; each step depends on the previous.

1. `curl https://lnkdrp.com/api/health` → `{"ok":true,"mongo":"ok"}`.
2. Sign in with Google. A personal workspace is created on first sign-in.
3. Upload a PDF, open the share link in a private window, confirm the summary renders and the
   view shows in the doc's quick stats.
4. Open `/connect`, create a key, run the Verify curl. The pill reads "Key verified".
5. `curl https://realtime.lnkdrp.com/healthz` shows at least one socket while your tab is open.
6. Add the MCP to Claude Code with that key, open a session; the sidebar flips to
   "1 connected · Claude Code" without a click. Ask it to share a PDF by URL and confirm the
   link. Or run the harness against production with a production key:
   `MCP_URL=https://mcp.lnkdrp.com/mcp npx tsx tests/mcp/e2e.ts` (it mints its own key from the
   database you point `MONGODB_URI` at; only run it with a key you then revoke).
7. Trigger one cron by hand and confirm 200:
   `curl -X POST https://lnkdrp.com/api/cron/plan-limits -H "Authorization: Bearer $CRON_SECRET"`.
8. Stripe: buy Pro with a real card, confirm the subscription shows in the dashboard and the
   webhook delivery log shows `checkout.session.completed` handled. Cancel it from the portal.
9. Revoke the test key from `/connect`; the sidebar returns to Not connected.

## 9. Release workflow

- `main` is production. Every push to `main` deploys the web app on Vercel; previews build from
  branches with the preview env (sandbox Stripe, a separate Atlas database).
- Before merging anything touching data shapes: add a migration under `db/migration/`, run it
  against production (section 4.1) before the deploy lands, since functions roll forward first.
- The realtime and MCP services do not auto-deploy. Rebuild and restart their images when a
  commit touches `realtime/`, `mcp/`, or `src/lib/realtime/ticket.ts`. They are backwards
  compatible with the web app across ordinary releases; deploy the web app first when both change.
- Local gate before pushing: `npx tsc --noEmit -p .`, `npx eslint src realtime mcp tests`,
  the four vitest suites (`npm run tests:credits:vitest` etc.), `npx next build`, and
  `npx tsx --env-file=.env.local tests/mcp/e2e.ts` when the MCP or the API-key seam changed.

## 10. Rollback

- **Web app:** Vercel → Deployments → promote the previous production deployment. Instant.
  Database migrations only add indexes, so an older build always runs against the newer schema.
- **Services:** re-run the previous image tag. Keep the last two images.
- **Stripe:** never delete prices; archive them. The app reads price ids from env, so a wrong
  price is fixed by changing the env and redeploying.
- **Kill switches:** rotate `CRON_SECRET` to stop all cron work; unset `NEXT_PUBLIC_REALTIME_URL`
  to fall back to polling; stop the MCP container to refuse agents (keys stay valid for the REST API).

## 11. Operating notes

- **Health:** `/api/health` (web), `/healthz` (both services). Point an uptime monitor at all three.
- **Logs:** Vercel function logs for the app; `docker logs` for the services. Errors are also
  recorded in the `errorevents` collection with a TTL (`ERROR_LOGGING_*` env, see `docs/ERROR_LOGGING.md`).
- **Scaling:** the web app scales with Vercel. Realtime is one instance until you add Redis
  pub/sub behind `broadcast()`. MCP is one instance or sticky sessions.
- **Secrets rotation:** `REALTIME_SECRET` must change on all three pieces in one go; tickets are
  60 seconds, so a brief mismatch only costs reconnects. `NEXTAUTH_SECRET` rotation signs
  everyone out.
- **What is intentionally off at launch:** Requests, AI review and Deep Search are hidden
  (`NEXT_PUBLIC_FEATURE_REQUESTS` unset). Paid seats are not sold; Pro includes one collaborator.

## 12. Known gaps before first production traffic

- Stripe live catalog and webhook do not exist yet; only the sandbox is configured.
- Neither service has a host yet; the guides already advertise `mcp.lnkdrp.com` and the
  realtime code advertises `realtime.lnkdrp.com`.
- The uncommitted edits from the parallel session (doc page, dashboard subscription card,
  history page, global styles, plan usage meter, paper plane) must be committed or discarded
  before the release that follows this runbook.
