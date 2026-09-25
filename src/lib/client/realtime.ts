"use client";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ACTIVE_ORG_CHANGED_EVENT } from "@/lib/sidebarCache";

/**
 * Browser side of the realtime channel (see `realtime/server.ts`): one shared WebSocket per tab,
 * opened lazily by the first subscriber, authenticated with a 60s ticket from
 * `GET /api/realtime/ticket`, reconnecting with backoff, and re-ticketed on a workspace switch.
 *
 * Frames are fanned out to `subscribeRealtime(type, handler)` listeners. `realtimeState()` tells
 * the polling hooks whether to back off: while the socket is open they poll far less often.
 *
 * When `NEXT_PUBLIC_REALTIME_URL` is unset the ticket endpoint returns no url and this module
 * stays idle; everything keeps working on polling.
 */
export type RealtimeFrame =
  /**
   * Sent by the server the moment a socket is accepted — including every reconnection.
   *
   * Subscribe to it to close the gap. The change streams carry no resume token across a
   * disconnect, so everything that happened while the socket was down is simply missing; a page
   * that refetches on `hello` catches up, and one that does not stays wrong until it is reloaded.
   */
  | { type: "hello"; orgId: string }
  | { type: "agent"; orgId: string; at: string }
  | { type: "activity"; orgId: string; event: { id: string; type: string | null; createdDate: string | null } }
  | { type: "doc"; orgId: string; doc: { id: string; status: string | null; shareId: string | null } }
  // An upload moved: the percent and the stage the pipeline wrote on the Upload row. Several of
  // these arrive per upload (the render loop throttles to ~one per 750ms); the Activity feed folds
  // them into its in-flight list with `mergeUploadFrame`.
  | {
      type: "upload";
      orgId: string;
      upload: { id: string; docId: string | null; percent: number; stage: string | null; status: string | null };
    }
  | { type: "project"; orgId: string; project: { id: string; name: string | null } }
  /**
   * A recipient arrived, or their volunteered name or email changed (they re-answered "introduce
   * yourself"). The metrics pages refetch on it so a corrected name does not wait for a reload.
   *
   * A nudge, never an identity: the name is read back through the gated REST endpoint, which is
   * the only place that knows the workspace's plan. This variant used to declare `name` as well,
   * and the server stopped sending it when reader identity was gated (see the long comment at
   * `broadcast(orgId, { type: "viewer" ... })` in `realtime/server.ts`, "Nothing here may ever
   * carry viewer identity again", and `tests/lib/realtimeViewerGate.test.ts`). The declaration
   * outlived the wire format, so `frame.viewer.name` still typechecked and was for ever
   * `undefined`: a reader would have concluded the name was being dropped somewhere in the browser
   * and fixed the display bug at the obvious end, by putting the name back on the wire, which is
   * the ungated leak the gate closed. Declaring exactly what the server sends is what stops that,
   * the same way the server refuses to declare `viewerName` on its own local shape.
   */
  | {
      type: "viewer";
      orgId: string;
      viewer: { docId: string | null; shareId: string | null };
    }
  /**
   * Someone is reading, right now — the visit clock, the page clock or the pages they have reached
   * just moved. Throttled server-side to at most one frame per reader per few seconds, so a fast
   * page-turner does not become a refetch storm.
   *
   * `viewerKey` is the PERSON (the bare digest), never the `<digest>.<docId>` composite a project
   * link stores, so a page can compare it with the key in its own address.
   */
  | {
      type: "reading";
      orgId: string;
      reading: {
        docId: string | null;
        shareId: string | null;
        viewerKey: string | null;
        viewerUserId: string | null;
        at: string;
      };
    }
  | { type: "ping" };

type Handler = (frame: RealtimeFrame) => void;

export type RealtimeState = "idle" | "connecting" | "open" | "closed" | "unavailable";
export const REALTIME_STATE_EVENT = "lnkdrp:realtime-state";

const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let state: RealtimeState = "idle";
let reconnectTimer: number | null = null;
// The liveness check of the current socket. `disconnect()` nulls `onclose` before closing, which
// is where the interval used to be cleared, so every workspace switch and every last-subscriber
// close leaked a 15 s timer that outlived its socket (code review 2026-09-23, Low).
let watchdogTimer: number | null = null;
let attempts = 0;
let wanted = false;
// Bumped on every disconnect/reconnect so a connect() still awaiting its ticket can tell it has
// been superseded (React strict-mode remounts and fast workspace switches otherwise opened a
// second socket next to the first).
let generation = 0;
let connecting = false;

function setState(next: RealtimeState) {
  if (state === next) return;
  state = next;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REALTIME_STATE_EVENT));
}

/** Current channel state (synchronous). */
export function realtimeState(): RealtimeState {
  return state;
}

function dispatch(frame: RealtimeFrame) {
  const set = handlers.get(frame.type);
  if (!set) return;
  for (const h of set) {
    try {
      h(frame);
    } catch {
      // one bad listener must not break the others
    }
  }
}

async function connect(): Promise<void> {
  if (!wanted || typeof window === "undefined") return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (connecting) return;
  connecting = true;
  const myGen = generation;
  setState("connecting");
  let url = "";
  let ticket: string | null = null;
  try {
    const res = await fetchWithTempUser("/api/realtime/ticket", { cache: "no-store" });
    // Signed out, or no longer a member of this workspace. Retrying cannot fix either, and doing
    // it every few seconds for the life of the tab is how a logged-out page quietly hammers an
    // endpoint. `unavailable` is the state the visibility handler re-probes from.
    if (res.status === 401 || res.status === 403) {
      connecting = false;
      setState("unavailable");
      return;
    }
    if (!res.ok) throw new Error(`ticket ${res.status}`);
    const json = (await res.json()) as { url?: string; ticket?: string | null };
    url = typeof json.url === "string" ? json.url : "";
    ticket = typeof json.ticket === "string" ? json.ticket : null;
  } catch {
    connecting = false;
    if (myGen === generation) scheduleReconnect();
    return;
  }
  connecting = false;
  /**
   * Superseded while the ticket was in flight — a workspace switch, or a remount.
   *
   * Opening this socket would be wrong: the ticket names the old workspace. But simply returning
   * left the channel with no socket and no timer, permanently: `disconnect()` bumps the generation
   * and the switch handler's own `connect()` had already bailed on `if (connecting) return`, so
   * this branch was the last thing running. The tab then stayed dead until it was hidden and shown
   * again. Re-entering is the whole fix — by now `connecting` is false, so the new call proceeds
   * and fetches a ticket for the workspace that is actually current.
   */
  if (myGen !== generation) {
    if (wanted) void connect();
    return;
  }
  if (!wanted) return;
  if (!url || !ticket) {
    // Realtime not configured for this deployment (or not signed in): stay on polling, quietly.
    setState("unavailable");
    return;
  }
  const ws = new WebSocket(`${url.replace(/\/+$/, "")}/?t=${encodeURIComponent(ticket)}`);
  socket = ws;
  /**
   * Nothing heard for this long means the connection is gone, whatever the socket says.
   *
   * The server pings every 25s, so silence past twice that is not a quiet workspace — it is a path
   * that died without a FIN (a Wi-Fi to cellular handoff, a VPN drop, a NAT binding expiring). The
   * browser will hold such a socket `OPEN` indefinitely, and `realtimeState()` would keep saying
   * "open", which is worse than saying nothing: every fallback poll in the app is gated on exactly
   * that check, so the page goes still AND stops polling. Closing it by hand puts the normal
   * reconnect path back in charge.
   */
  const DEAD_AFTER_MS = 70_000;
  let lastFrameAt = Date.now();
  if (watchdogTimer !== null) window.clearInterval(watchdogTimer);
  const watchdog = window.setInterval(() => {
    if (socket !== ws) return;
    if (Date.now() - lastFrameAt < DEAD_AFTER_MS) return;
    ws.close();
  }, 15_000);
  watchdogTimer = watchdog;
  ws.onopen = () => {
    attempts = 0;
    lastFrameAt = Date.now();
    setState("open");
  };
  ws.onmessage = (ev) => {
    // A socket that has been replaced must not speak for the channel.
    if (socket !== ws) return;
    lastFrameAt = Date.now();
    let frame: RealtimeFrame | null = null;
    try {
      frame = JSON.parse(String(ev.data)) as RealtimeFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;
    if (frame.type === "ping") {
      ws.send('{"type":"pong"}');
      return;
    }
    dispatch(frame);
  };
  ws.onclose = () => {
    window.clearInterval(watchdog);
    if (watchdogTimer === watchdog) watchdogTimer = null;
    // An old socket closing after a switch says nothing about the current one.
    if (socket !== ws) return;
    socket = null;
    setState("closed");
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose follows; nothing else to do
  };
}

/** Consecutive failures after which a server is treated as down rather than blipping. */
const SETTLED_AFTER_ATTEMPTS = 10;
/** The slow cadence used from then on. */
const SETTLED_DELAY_MS = 300_000;

function scheduleReconnect() {
  if (!wanted || reconnectTimer !== null) return;
  attempts += 1;
  /**
   * 1s, 2s, 4s … 30s, then five minutes once it is clear nobody is answering.
   *
   * A 30-second ceiling is right for a blip and wrong for an outage: while the realtime host is
   * down, every open tab wakes a dynamic route that reads Mongo twice, twice a minute, for as long
   * as the tab stays open. A server that has refused ten consecutive attempts is not coming back
   * within thirty seconds, and everything that reads realtime already falls back to polling, so
   * the only thing the fast retry buys after that point is load. Jitter throughout, so a fleet of
   * tabs does not stampede when it does come back.
   */
  const jitter = 0.75 + Math.random() * 0.5;
  // The exponent has to grow with the ceiling, or raising the cap changes nothing: 2**5 is 32s, so
  // a five-minute ceiling on a five-step exponent is still a thirty-second wait.
  const steps = attempts > SETTLED_AFTER_ATTEMPTS ? 9 : 5;
  const ceiling = attempts > SETTLED_AFTER_ATTEMPTS ? SETTLED_DELAY_MS : 30_000;
  const delay = Math.min(ceiling, 1000 * 2 ** Math.min(attempts, steps)) * jitter;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function disconnect() {
  generation += 1;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ws = socket;
  socket = null;
  if (watchdogTimer !== null) {
    window.clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  setState(wanted ? "closed" : "idle");
}

/**
 * Subscribe to frames of one type. The first subscriber opens the socket; the last one closing
 * its subscription closes it. Returns an unsubscribe function.
 */
export function subscribeRealtime(type: RealtimeFrame["type"], handler: Handler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  wanted = true;
  void connect();
  return () => {
    set?.delete(handler);
    if (set && set.size === 0) handlers.delete(type);
    if (handlers.size === 0) {
      wanted = false;
      disconnect();
    }
  };
}

if (typeof window !== "undefined") {
  // A workspace switch changes the ticket's orgId: drop the socket and come back on the new one.
  window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, () => {
    if (!wanted) return;
    disconnect();
    attempts = 0;
    void connect();
  });
  // Tabs that were asleep often hold a dead socket; reconnect promptly when they wake.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wanted && state !== "open" && state !== "connecting") {
      attempts = 0;
      void connect();
    }
  });
}
