/**
 * Wait for a document to finish processing.
 *
 * Two signals race: (a) the realtime channel (`realtime/server.ts`), joined with a ticket signed
 * by the shared secret for the key's workspace, which pushes `{"type":"doc","doc":{id,status}}`
 * the moment the status flips; and (b) a `GET /api/docs/:id?lite=1` poll every 2s. The socket is
 * strictly an accelerator: when `NEXT_PUBLIC_REALTIME_URL` is unset, no secret is configured, or
 * the socket fails for any reason, polling alone finishes the wait. Every realtime hint is
 * confirmed with a GET, so the returned doc is always what the API says.
 */
import WebSocket from "ws";

import { signRealtimeTicket } from "../../src/lib/realtime/ticket";
import type { ApiClient, ApiDoc } from "./api";
import { log } from "./config";

export const DOC_POLL_MS = 2000;

const TERMINAL = new Set(["ready", "failed"]);

/** True when processing is over (successfully or not). */
export function isTerminalDocStatus(status: string): boolean {
  return TERMINAL.has(status);
}

type Hint = { promise: Promise<void>; close: () => void };

/**
 * Open a realtime socket that resolves once a terminal `doc` frame for `docId` arrives. Returns
 * null when realtime is not configured; never rejects (failures just leave the promise pending).
 */
function openDocHint(input: { url: string; userId: string; orgId: string; docId: string }): Hint | null {
  let ticket: string;
  try {
    ticket = signRealtimeTicket({ userId: input.userId, orgId: input.orgId }).ticket;
  } catch (err) {
    log("realtime: cannot sign ticket, polling only", err instanceof Error ? err.message : err);
    return null;
  }
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${input.url}/?t=${encodeURIComponent(ticket)}`);
  } catch (err) {
    log("realtime: cannot open socket, polling only", err instanceof Error ? err.message : err);
    return null;
  }
  let closing = false;
  const promise = new Promise<void>((resolve) => {
    ws.on("message", (raw) => {
      let frame: { type?: unknown; doc?: { id?: unknown; status?: unknown } } | null = null;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== "string") return;
      if (frame.type === "ping") {
        ws.send('{"type":"pong"}');
        return;
      }
      if (frame.type === "doc" && frame.doc?.id === input.docId && typeof frame.doc.status === "string" && isTerminalDocStatus(frame.doc.status)) {
        resolve();
      }
    });
    ws.on("error", (err) => {
      // Closing a still-connecting socket (polling won the race) also emits an error; not worth a log line.
      if (!closing) log("realtime: socket error, polling continues", err.message);
    });
    // A close before the frame arrives leaves the promise pending; polling finishes the wait.
  });
  return {
    promise,
    close: () => {
      closing = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}

/** Resolve after `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WaitForDocInput = {
  api: ApiClient;
  docId: string;
  timeoutMs: number;
  realtime: { url: string | null; secretConfigured: boolean };
  identity: { userId: string; orgId: string };
  /** Called after every poll with the elapsed time, for progress notifications. */
  onTick?: (info: { elapsedMs: number; status: string }) => void;
  pollMs?: number;
};

/** Poll (and listen) until the doc is `ready`/`failed` or the timeout elapses. */
export async function waitForDocStatus(input: WaitForDocInput): Promise<{ doc: ApiDoc; timedOut: boolean }> {
  const started = Date.now();
  const pollMs = input.pollMs ?? DOC_POLL_MS;
  let hint: Hint | null =
    input.realtime.url && input.realtime.secretConfigured
      ? openDocHint({ url: input.realtime.url, userId: input.identity.userId, orgId: input.identity.orgId, docId: input.docId })
      : null;

  try {
    let doc = await input.api.getDoc(input.docId);
    while (!isTerminalDocStatus(doc.status)) {
      const remaining = input.timeoutMs - (Date.now() - started);
      if (remaining <= 0) return { doc, timedOut: true };
      const waiters: Array<Promise<"poll" | "hint">> = [sleep(Math.min(pollMs, remaining)).then(() => "poll" as const)];
      if (hint) waiters.push(hint.promise.then(() => "hint" as const));
      const winner = await Promise.race(waiters);
      if (winner === "hint" && hint) {
        // Consume the hint once; the GET below is the source of truth.
        hint.close();
        hint = null;
      }
      doc = await input.api.getDoc(input.docId);
      input.onTick?.({ elapsedMs: Date.now() - started, status: doc.status });
    }
    return { doc, timedOut: false };
  } finally {
    hint?.close();
  }
}
