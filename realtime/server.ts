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
 *     {"type":"upload","orgId":…,"upload":{id,docId,percent,stage,status}}  an upload moved along
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
import { splitProjectViewerKey } from "../src/lib/share/projectPublic";

const PORT = Number(process.env.REALTIME_PORT || 8788);
const MONGODB_URI = (process.env.MONGODB_URI || "").trim();
const PING_MS = 25_000;
// Longer than serverSelectionTimeoutMS below, the most a driver resume waits before giving up.
const STREAM_RESUME_GRACE_MS = 30_000;
const STREAM_EXIT_DELAY_MS = 5_000;

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
  // The driver resumes transient errors itself, and both events fire on a stream that lives on: a
  // throw in a 'change' handler emits 'error' with the stream open, and a resume closes the old
  // cursor, which emits 'close'. So after either, wait out the resume and only then trust `closed`.
  // A dead stream turns /healthz 503 and exits the process: Fly http checks only pull the one
  // machine out of routing, and only an exit gets it restarted with fresh streams.
  const streamHealth: Record<"activity" | "apikeys" | "docs" | "projects" | "uploads" | "shareviews" | "projectlinkviews", boolean> = {
    activity: true,
    apikeys: true,
    docs: true,
    projects: true,
    uploads: true,
    shareviews: true,
    projectlinkviews: true,
  };
  let shuttingDown = false;
  let exiting = false;
  const watchHealth = (name: keyof typeof streamHealth, stream: mongoose.mongo.ChangeStream) => {
    const check = () => {
      setTimeout(() => {
        if (shuttingDown || exiting || !stream.closed) return;
        streamHealth[name] = false;
        exiting = true;
        log(`${name} stream closed for good; /healthz now 503, exiting in ${STREAM_EXIT_DELAY_MS / 1000}s so the machine restarts`);
        setTimeout(() => process.exit(1), STREAM_EXIT_DELAY_MS);
      }, STREAM_RESUME_GRACE_MS);
    };
    stream.on("error", (err) => {
      if (!shuttingDown) log(`${name} stream error`, err);
      check();
    });
    stream.on("close", check);
  };

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
  watchHealth("activity", activity);

  const keys = db
    .collection("apikeys")
    .watch([{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }], { fullDocument: "updateLookup" });
  keys.on("change", (change) => {
    const doc = (change as { fullDocument?: { orgId?: unknown } }).fullDocument;
    if (!doc?.orgId) return;
    broadcast(String(doc.orgId), { type: "agent", at: new Date().toISOString() });
  });
  watchHealth("apikeys", keys);

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
  watchHealth("docs", docs);

  // Projects: created, renamed or deleted. Documents reach the sidebar through their status flips
  // above, but a project has no status, so one created over MCP never showed up until a reload.
  const projects = db
    .collection("projects")
    .watch([{ $match: { operationType: { $in: ["insert", "update", "replace", "delete"] } } }], { fullDocument: "updateLookup" });
  projects.on("change", (change) => {
    const doc = (change as { fullDocument?: { _id?: unknown; orgId?: unknown; name?: unknown } }).fullDocument;
    // A delete carries no fullDocument; the client refetches its list either way, so the id is enough.
    const orgId = doc?.orgId;
    if (!orgId) return;
    broadcast(String(orgId), {
      type: "project",
      project: { id: String(doc?._id ?? ""), name: typeof doc?.name === "string" ? doc.name : null },
    });
  });
  watchHealth("projects", projects);

  // Upload progress. A doc's status flip above says "it finished"; this says how far along it is
  // while it is still going — the percent and the stage the pipeline wrote on the Upload row (see
  // src/lib/uploads/progress.ts). Matching on `progress` keeps the other upload writes (the blob
  // url, the extracted text, the AI output — all large) off the channel entirely.
  //
  // `progress.orgId` is stamped by the writer precisely so this handler needs no second query per
  // page: a fifty-page deck is fifteen-odd frames, and a lookup on each would be a lookup per frame.
  const uploads = db
    .collection("uploads")
    .watch(
      [
        {
          $match: {
            operationType: "update",
            // A whole-subdocument `$set` reports the path `progress`; a leaf write would report
            // `progress.percent`. Match both so a future narrower write still reaches the room.
            $or: [
              { "updateDescription.updatedFields.progress": { $exists: true } },
              { "updateDescription.updatedFields.progress.percent": { $exists: true } },
            ],
          },
        },
      ],
      { fullDocument: "updateLookup" },
    );
  uploads.on("change", (change) => {
    const doc = (change as {
      fullDocument?: {
        _id?: unknown;
        orgId?: unknown;
        docId?: unknown;
        status?: unknown;
        progress?: { percent?: unknown; stage?: unknown; orgId?: unknown };
      };
    }).fullDocument;
    const orgId = doc?.progress?.orgId ?? doc?.orgId;
    if (!orgId) return;
    const percent = Number(doc?.progress?.percent);
    broadcast(String(orgId), {
      type: "upload",
      upload: {
        id: String(doc?._id ?? ""),
        docId: doc?.docId ? String(doc.docId) : null,
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
        stage: typeof doc?.progress?.stage === "string" ? doc.progress.stage : null,
        status: typeof doc?.status === "string" ? doc.status : null,
      },
    });
  });
  watchHealth("uploads", uploads);

  // Someone new opened it, or someone already here said who they are.
  //
  // Two events, one frame. The insert is the arrival: a `shareviews` row is written once per
  // (link, reader) — and once per document behind a project link — so it fires when a person
  // appears for the first time and never again while they read. That is the event an owner is
  // actually watching the page for, and it was the one the channel did not carry: the metrics page
  // only moved when a *name* changed, so a new reader arriving left it completely still until a
  // reload. Reported as "the metrics pages need to be realtime dynamic... it didn't show me as a
  // new visitor".
  //
  // The update half carries two different events now. An identity change is the second answer to
  // "introduce yourself" — someone fixes a typo or adds a surname, the app writes it through to
  // that person's rows (`propagateViewerIdentity`), and an owner watching should see the name
  // correct itself. A progress change is someone reading: the visit clock, the page clock, the
  // pages they have reached.
  //
  // Progress used to be excluded outright, because a reader's heartbeat touches this collection
  // repeatedly and the channel would carry every beat of it. What makes it affordable is that a
  // frame is not a beat: `progressThrottle` collapses one reader's writes into at most one frame
  // every few seconds, which is the resolution a person watching a page can perceive anyway.
  //
  // Owner previews are broadcast too, deliberately. They are excluded from every figure on the
  // page (`RECIPIENT_ONLY_MATCH`) but counted in `totals.ownerPreviews`, which the page shows —
  // so an owner opening their own link to test it sees that number move, instead of a page that
  // looks broken because it correctly refused to count them.
  /**
   * One frame per reader per few seconds, however hard they are reading.
   *
   * A reader writes on a 30-second heartbeat (`HEARTBEAT_MS`) and again on every page turn, so
   * someone flipping through a deck can write several times a second. Each frame asks every open
   * metrics page in that workspace to refetch, so the flood is not the channel's problem — it is
   * the refetch storm behind it.
   *
   * Keyed per (workspace, document, person), so two people reading at once are not throttled into
   * one, and pruned on a timer: the map holds only readers seen in the last few minutes, which
   * bounds it by concurrent readers rather than by readers ever seen. Losing a frame costs
   * nothing — the next beat is seconds away, and the page refetches the whole truth each time.
   */
  const progressThrottle = (() => {
    const MIN_GAP_MS = 3_000;
    const PRUNE_AFTER_MS = 60_000;
    const seen = new Map<string, number>();
    setInterval(() => {
      const cutoff = Date.now() - PRUNE_AFTER_MS;
      for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
    }, PRUNE_AFTER_MS).unref();
    return {
      allow(key: string): boolean {
        const now = Date.now();
        const last = seen.get(key) ?? 0;
        if (now - last < MIN_GAP_MS) return false;
        seen.set(key, now);
        return true;
      },
    };
  })();

  const shareViews = db.collection("shareviews").watch(
    [
      {
        $match: {
          $or: [
            { operationType: "insert" },
            {
              operationType: "update",
              $or: [
                { "updateDescription.updatedFields.viewerName": { $exists: true } },
                { "updateDescription.updatedFields.viewerEmailSnapshot": { $exists: true } },
                // Reading in progress: the heartbeat's visit clock, the page clock, and the set of
                // pages reached. These are the writes the filter used to exclude on purpose — see
                // `progressThrottle` below for what changed and why it is now affordable.
                { "updateDescription.updatedFields.timeSpentMs": { $exists: true } },
                { "updateDescription.updatedFields.pagesSeen": { $exists: true } },
                { "updateDescription.updatedFields.pageTimeMsByPage": { $exists: true } },
              ],
            },
          ],
        },
      },
    ],
    { fullDocument: "updateLookup" },
  );
  shareViews.on("change", (change) => {
    const c = change as {
      operationType?: string;
      updateDescription?: { updatedFields?: Record<string, unknown> };
      fullDocument?: {
        orgId?: unknown;
        docId?: unknown;
        shareId?: unknown;
        botIdHash?: unknown;
        viewerUserId?: unknown;
        viewerName?: unknown;
        isOwnerPreview?: unknown;
      };
    };
    const doc = c.fullDocument;
    if (!doc?.orgId) return;
    const orgId = String(doc.orgId);
    const changed = c.updateDescription?.updatedFields ?? {};
    const isUpdate = c.operationType === "update";

    // An arrival, or a name: the frame every metrics surface already listens on.
    const identityChanged = "viewerName" in changed || "viewerEmailSnapshot" in changed;
    if (!isUpdate || identityChanged) {
      broadcast(orgId, {
        type: "viewer",
        viewer: {
          docId: doc.docId ? String(doc.docId) : null,
          shareId: typeof doc.shareId === "string" ? doc.shareId : null,
          name: typeof doc.viewerName === "string" ? doc.viewerName : null,
        },
      });
    }

    // Progress: they are reading right now, and a page watching them should say so.
    const progressed = "timeSpentMs" in changed || "pagesSeen" in changed || "pageTimeMsByPage" in changed;
    if (!isUpdate || !progressed) return;
    // The owner checking their own link is recorded and counted nowhere, so a frame for it would
    // ask every open page to refetch and find nothing changed.
    if (doc.isOwnerPreview === true) return;

    const docId = doc.docId ? String(doc.docId) : null;
    // The PERSON: a project link stores `<digest>.<docId>` so three files behind one slug do not
    // collide, and the reader pages are addressed by the digest alone.
    const viewerKey = typeof doc.botIdHash === "string" ? splitProjectViewerKey(doc.botIdHash).botIdHash : null;
    const viewerUserId = doc.viewerUserId ? String(doc.viewerUserId) : null;
    if (!progressThrottle.allow(`${orgId}:${docId}:${viewerUserId ?? viewerKey}`)) return;

    broadcast(orgId, {
      type: "reading",
      reading: {
        docId,
        // No project here on purpose: a `ShareView` has no `projectId` (the link does), so a field
        // for it could only ever be null. A client that needs the room knows it from its own
        // address, and the document is enough to decide whether this frame is about it.
        shareId: typeof doc.shareId === "string" ? doc.shareId : null,
        viewerKey,
        viewerUserId,
        at: new Date().toISOString(),
      },
    });
  });
  watchHealth("shareviews", shareViews);

  // The same two events on the row a visitor writes when they open a data room and read nothing.
  // The arrival is the whole point of this collection — someone landed and opened no document —
  // and without the insert it reached the metrics page only on the next reload.
  const projectLinkViews = db.collection("projectlinkviews").watch(
    [
      {
        $match: {
          $or: [
            { operationType: "insert" },
            {
              operationType: "update",
              $or: [
                { "updateDescription.updatedFields.viewerName": { $exists: true } },
                { "updateDescription.updatedFields.viewerEmailSnapshot": { $exists: true } },
              ],
            },
          ],
        },
      },
    ],
    { fullDocument: "updateLookup" },
  );
  projectLinkViews.on("change", (change) => {
    const doc = (change as { fullDocument?: { orgId?: unknown; shareId?: unknown; viewerName?: unknown } }).fullDocument;
    if (!doc?.orgId) return;
    broadcast(String(doc.orgId), {
      type: "viewer",
      viewer: {
        // No document: this is an arrival, not a reading.
        docId: null,
        shareId: typeof doc.shareId === "string" ? doc.shareId : null,
        name: typeof doc.viewerName === "string" ? doc.viewerName : null,
      },
    });
  });
  watchHealth("projectlinkviews", projectLinkViews);

  // --- http + ws ---------------------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      const ok = Object.values(streamHealth).every(Boolean);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok, streams: streamHealth, rooms: rooms.size, sockets: Array.from(rooms.values()).reduce((n, r) => n + r.size, 0) }),
      );
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
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const room of rooms.values()) for (const c of room) c.close(1001, "server shutting down");
    await Promise.allSettled([activity.close(), keys.close(), docs.close(), projects.close(), uploads.close()]);
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
