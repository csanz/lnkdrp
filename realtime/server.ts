/**
 * lnkdrp realtime server — a standalone WebSocket service that pushes workspace events to the
 * browser: agent connections and key changes (`agent`), and every new activity row (`activity`).
 *
 * Run: `npm run realtime` (tsx, reads .env.local) or `node --import tsx realtime/server.ts`.
 * Deploy anywhere that can hold a socket (Fly, Railway, a VM, the worker host); it is NOT a
 * Vercel function. Env: MONGODB_URI (must be a replica set; change streams), REALTIME_SECRET or
 * NEXTAUTH_SECRET (shared with the Next app), REALTIME_PORT (default 8788).
 *
 * Protocol
 * - Client connects to `ws(s)://host/?t=<ticket>` with a ticket from `GET /api/realtime/ticket`
 *   (HMAC, 60s, bound to user + workspace). Bad or expired ticket → close 4401.
 * - Server → client JSON frames:
 *     {"type":"hello","orgId":…}                     on accept
 *     {"type":"agent","orgId":…,"at":iso}             an API key was used, created or revoked
 *     {"type":"activity","orgId":…,"event":{id,type,createdDate}}  a new activity row
 *     {"type":"doc","orgId":…,"doc":{id,status,shareId}}  a document's processing status changed
 *     {"type":"ping"}                                 every 25s; client answers {"type":"pong"}
 *
 * The MCP server uses the same channel two ways: everything it writes (activity rows, docs it
 * creates through `share_pdf`) is fanned out by the change streams with no extra code, and it can
 * subscribe itself, signing a ticket with the shared secret for the key's workspace
 * (`signRealtimeTicket` in src/lib/realtime/ticket.ts), to return from `share_pdf` the moment the
 * `doc` frame says "ready" instead of polling `get_share`.
 * - Client → server: {"type":"pong"} only. Anything else is ignored.
 * - Sockets that miss two pings are dropped. A ticket authorises the socket for its lifetime;
 *   revoking membership takes effect on the next reconnect (tickets are 60s, so at most one
 *   missed reconnect).
 *
 * Fan-out: one Mongo change stream per collection for the whole process, keyed by orgId into
 * in-memory rooms. This scales to one instance; for more, put a broker (Redis pub/sub) between
 * the change streams and the rooms — the room API below is the seam.
 */
import http from "node:http";
import mongoose from "mongoose";
import { WebSocketServer, WebSocket } from "ws";

import { verifyRealtimeTicket } from "../src/lib/realtime/ticket";

const PORT = Number(process.env.REALTIME_PORT || 8788);
const MONGODB_URI = (process.env.MONGODB_URI || "").trim();
const PING_MS = 25_000;

if (!MONGODB_URI) {
  console.error("[realtime] MONGODB_URI is required");
  process.exit(1);
}

type Client = WebSocket & { orgId: string; userId: string; missedPings: number };

/** orgId → sockets. */
const rooms = new Map<string, Set<Client>>();

function join(client: Client) {
  let room = rooms.get(client.orgId);
  if (!room) {
    room = new Set();
    rooms.set(client.orgId, room);
  }
  room.add(client);
}

function leave(client: Client) {
  const room = rooms.get(client.orgId);
  if (!room) return;
  room.delete(client);
  if (room.size === 0) rooms.delete(client.orgId);
}

function broadcast(orgId: string, frame: Record<string, unknown>) {
  const room = rooms.get(orgId);
  if (!room || room.size === 0) return;
  const data = JSON.stringify({ ...frame, orgId });
  for (const c of room) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), "[realtime]", ...args);
}

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db;
  if (!db) throw new Error("no db handle after connect");
  log("mongo connected");

  // --- change streams -------------------------------------------------------------------------
  const activity = db.collection("activityevents").watch([{ $match: { operationType: "insert" } }], { fullDocument: "updateLookup" });
  activity.on("change", (change) => {
    if (change.operationType !== "insert") return;
    const doc = change.fullDocument as { _id?: unknown; orgId?: unknown; type?: unknown; createdDate?: unknown } | undefined;
    if (!doc?.orgId) return;
    broadcast(String(doc.orgId), {
      type: "activity",
      event: {
        id: String(doc._id),
        type: typeof doc.type === "string" ? doc.type : null,
        createdDate: doc.createdDate instanceof Date ? doc.createdDate.toISOString() : null,
      },
    });
  });
  activity.on("error", (err) => log("activity stream error", err));

  const keys = db
    .collection("apikeys")
    .watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], { fullDocument: "updateLookup" });
  keys.on("change", (change) => {
    const doc = (change as { fullDocument?: { orgId?: unknown } }).fullDocument;
    if (!doc?.orgId) return;
    broadcast(String(doc.orgId), { type: "agent", at: new Date().toISOString() });
  });
  keys.on("error", (err) => log("apikeys stream error", err));

  // Document processing status (preparing → ready/failed) — the doc page, the sidebar and the MCP
  // server's share_pdf all want to know the moment it flips.
  const docs = db
    .collection("docs")
    .watch([{ $match: { operationType: { $in: ["update", "replace"] }, "updateDescription.updatedFields.status": { $exists: true } } }], {
      fullDocument: "updateLookup",
    });
  docs.on("change", (change) => {
    const doc = (change as { fullDocument?: { _id?: unknown; orgId?: unknown; status?: unknown; shareId?: unknown } }).fullDocument;
    if (!doc?.orgId) return;
    broadcast(String(doc.orgId), {
      type: "doc",
      doc: { id: String(doc._id), status: typeof doc.status === "string" ? doc.status : null, shareId: typeof doc.shareId === "string" ? doc.shareId : null },
    });
  });
  docs.on("error", (err) => log("docs stream error", err));

  // --- http + ws ---------------------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, sockets: Array.from(rooms.values()).reduce((n, r) => n + r.size, 0) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://localhost");
    const ticket = verifyRealtimeTicket(url.searchParams.get("t"));
    if (!ticket) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = ws as Client;
      client.orgId = ticket.orgId;
      client.userId = ticket.userId;
      client.missedPings = 0;
      wss.emit("connection", client, req);
    });
  });

  wss.on("connection", (client: Client) => {
    join(client);
    client.send(JSON.stringify({ type: "hello", orgId: client.orgId }));
    client.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: unknown };
        if (msg?.type === "pong") client.missedPings = 0;
      } catch {
        // ignore
      }
    });
    client.on("close", () => leave(client));
    client.on("error", () => leave(client));
  });

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const c of room) {
        if (c.readyState !== WebSocket.OPEN) continue;
        if (c.missedPings >= 2) {
          c.terminate();
          continue;
        }
        c.missedPings += 1;
        c.send('{"type":"ping"}');
      }
    }
  }, PING_MS);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[realtime] port ${PORT} is already in use. Another realtime server is running; stop it or set REALTIME_PORT.`);
    } else {
      console.error("[realtime] server error", err);
    }
    process.exit(1);
  });
  server.listen(PORT, () => log(`listening on :${PORT}`));

  const shutdown = async () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) for (const c of room) c.close(1001, "server shutting down");
    await Promise.allSettled([activity.close(), keys.close(), docs.close()]);
    await mongoose.disconnect();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[realtime] fatal", err);
  process.exit(1);
});
