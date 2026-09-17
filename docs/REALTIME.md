# Realtime (WebSocket) server

A standalone Node service that pushes workspace events to browsers (and to the MCP server) the
moment they happen: an agent's first tool call flips the sidebar to Connected, a new activity row
appears in the feed, a document's processing status changes. Vercel functions cannot hold a
socket, so this runs on its own host.

- Code: `realtime/server.ts` (server), `src/lib/client/realtime.ts` (browser client),
  `src/lib/realtime/ticket.ts` (shared ticket signer), `src/app/api/realtime/ticket/route.ts`.
- Run locally: `npm run realtime` (tsx, reads `.env.local`). Production: `npm run realtime:prod`
  or a Dockerfile around `node --import tsx realtime/server.ts`.
- Health: `GET /healthz` → `{ ok, rooms, sockets }`.

## How it works

1. The browser calls `GET /api/realtime/ticket` (session auth, any member). The app returns
   `NEXT_PUBLIC_REALTIME_URL` and a 60s HMAC ticket bound to the user and the active workspace.
2. The browser opens `ws(s)://<realtime host>/?t=<ticket>`. The server verifies the ticket with
   the shared secret (`REALTIME_SECRET`, falling back to `NEXTAUTH_SECRET`) and joins the socket
   to the workspace's room. Bad or expired ticket → 401 at upgrade.
3. The server holds one Mongo change stream per collection and fans matching changes out to the
   room:
   - `activityevents` inserts → `{"type":"activity","orgId","event":{id,type,createdDate}}`
   - `apikeys` insert/update/replace → `{"type":"agent","orgId","at"}` (key used, created, revoked)
   - `docs` status changes → `{"type":"doc","orgId","doc":{id,status,shareId}}`
   - `projects` insert/update/replace/delete → `{"type":"project","orgId","project":{id,name}}`
   - `uploads` writes that touch `progress` → `{"type":"upload","orgId","upload":{id,docId,percent,stage,status}}`
     — how far a running upload has got ("rendering page 3 of 9"). The pipeline writes it at every
     real boundary, throttled to ~one write per 750ms per upload (first and last exempt), and the
     Activity feed draws it as a bar. The routing key is `progress.orgId`, stamped by the writer so
     this handler needs no lookup per frame. See `src/lib/uploads/progress.ts`.
4. Heartbeat: `{"type":"ping"}` every 25s; the client answers `{"type":"pong"}`; two misses drop
   the socket. The client reconnects with jittered backoff (1s → 30s), re-tickets on a workspace
   switch, and reconnects when a sleeping tab wakes.

The browser keeps polling as a safety net: `useAgentStatus({ pollMs })` stretches its interval
to at least 60s while the socket is open and drops back to its normal rate when it is not; the
activity feed keeps its 10s fallback timer. When `NEXT_PUBLIC_REALTIME_URL` is unset the ticket
endpoint returns no url and everything stays on polling.

## MCP server

The MCP server uses the same channel in both directions:

- **Out:** every write it makes (activity rows via `recordActivity`, docs created by
  `share_pdf`) reaches browsers through the change streams with no extra code.
- **In:** it can subscribe like a browser, signing its own ticket with the shared secret for the
  key's workspace (`signRealtimeTicket({ userId, orgId })` from `src/lib/realtime/ticket.ts`,
  since it has the secret), and wait for the `doc` frame that says `ready` to return from
  `share_pdf` instead of polling `get_share`.

## Env

| Variable | Where | Meaning |
|---|---|---|
| `NEXT_PUBLIC_REALTIME_URL` | Next app | `ws://localhost:8788` locally, `wss://realtime.lnkdrp.com` in production. Unset = polling only. |
| `REALTIME_SECRET` | Next app + realtime server | Shared HMAC secret for tickets. Falls back to `NEXTAUTH_SECRET`. |
| `REALTIME_PORT` | realtime server | Listen port, default 8788. |
| `MONGODB_URI` | realtime server | Must be a replica set (local `rs0`, Atlas) — change streams need one. |

## Scaling

One instance holds all rooms in memory; that is fine for launch. Past one instance, put a broker
(Redis pub/sub) between the change streams and the rooms so any instance can serve any
workspace — `broadcast()` in `realtime/server.ts` is the seam. Mongo change streams themselves
are cheap; one per collection per instance.
