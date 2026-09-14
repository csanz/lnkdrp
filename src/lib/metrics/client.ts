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

/**
 * Track time spent on one page (slide) of a document version — the `DocPageTiming` collection,
 * which answers "did this member open v3, and how far did they read?".
 *
 * Internal-member telemetry: `/api/metrics/events` attributes an event only to a signed-in or
 * already-existing temp user whose workspace can see the document, so an anonymous share-page
 * visitor can never write one. Pass `shareId` when the reader arrived through a share link, so
 * the row can be scoped to that link.
 */
export function trackDocPageTiming(args: {
  docId: string;
  version: number;
  pageNumber: number;
  enteredAtMs: number;
  leftAtMs: number;
  shareId?: string | null;
}) {
  const sessionId = getSessionId();
  void postEvent({
    type: "doc_page_timing",
    sessionId,
    docId: args.docId,
    version: args.version,
    pageNumber: args.pageNumber,
    enteredAtMs: args.enteredAtMs,
    leftAtMs: args.leftAtMs,
    ...(args.shareId ? { shareId: args.shareId } : {}),
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