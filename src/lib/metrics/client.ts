"use client";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/**
 * Client-side metrics event helpers.
 *
 * These functions post lightweight analytics events to our API. They are
 * best-effort and should never throw or block user interactions.
 */
const SESSION_ID_KEY = "lnkdrp_session_id";

/** Generate a cryptographically-random hex string of the given byte length. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Return a stable per-tab/session id, persisted in `sessionStorage`.
 * Falls back to an ephemeral id if storage is unavailable.
 */
export function getSessionId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.sessionStorage.getItem(SESSION_ID_KEY);
    if (existing && typeof existing === "string") return existing;
    const created = `s_${randomHex(16)}`;
    window.sessionStorage.setItem(SESSION_ID_KEY, created);
    return created;
  } catch {
    // If sessionStorage is blocked, fall back to an in-memory-ish value.
    return `s_${randomHex(16)}`;
  }
}

/** Post an analytics event to the server (best-effort; never throws). */
async function postEvent(payload: Record<string, unknown>): Promise<void> {
  try {
    void (await fetchWithTempUser("/api/metrics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keepalive helps on route transitions / tab close
      keepalive: true,
      body: JSON.stringify(payload),
    }));
  } catch {
    // best-effort
  }
}

/** Track that a project page was viewed. */
export function trackProjectView(args: { projectId: string; path: string }) {
  const sessionId = getSessionId();
  void postEvent({ type: "project_view", sessionId, projectId: args.projectId, path: args.path });
}

/** Track a click from within a project view (e.g. navigating to a doc). */
export function trackProjectClick(args: { projectId: string; fromPath: string; toPath: string; toDocId?: string | null }) {
  const sessionId = getSessionId();
  void postEvent({
    type: "project_click",
    sessionId,
    projectId: args.projectId,
    fromPath: args.fromPath,
    toPath: args.toPath,
    ...(args.toDocId ? { toDocId: args.toDocId } : {}),
  });
}

/** Track a page timing event, measured in epoch milliseconds. */
export function trackPageTiming(args: {
  path: string;
  referrer?: string | null;
  enteredAtMs: number;
  leftAtMs: number;
}) {
  const sessionId = getSessionId();
  void postEvent({
    type: "page_timing",
    sessionId,
    path: args.path,
    referrer: args.referrer ?? null,
    enteredAtMs: args.enteredAtMs,
    leftAtMs: args.leftAtMs,
  });
}