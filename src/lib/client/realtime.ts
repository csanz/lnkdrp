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
  | { type: "ping" };

type Handler = (frame: RealtimeFrame) => void;

export type RealtimeState = "idle" | "connecting" | "open" | "closed" | "unavailable";
export const REALTIME_STATE_EVENT = "lnkdrp:realtime-state";

const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let state: RealtimeState = "idle";
let reconnectTimer: number | null = null;
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
  // Superseded while fetching the ticket (unsubscribed, or workspace switched): do not open.
  if (myGen !== generation || !wanted) return;
  if (!url || !ticket) {
    // Realtime not configured for this deployment (or not signed in): stay on polling, quietly.
    setState("unavailable");
    return;
  }
  const ws = new WebSocket(`${url.replace(/\/+$/, "")}/?t=${encodeURIComponent(ticket)}`);
  socket = ws;
  ws.onopen = () => {
    attempts = 0;
    setState("open");
  };
  ws.onmessage = (ev) => {
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
    if (socket === ws) socket = null;
    setState("closed");
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose follows; nothing else to do
  };
}

function scheduleReconnect() {
  if (!wanted || reconnectTimer !== null) return;
  attempts += 1;
  // 1s, 2s, 4s … capped at 30s, with jitter so a fleet of tabs does not stampede.
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)) * (0.75 + Math.random() * 0.5);
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
