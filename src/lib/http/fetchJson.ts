/**
 * Small fetch helpers for JSON APIs.
 *
 * Centralizes:
 * - JSON parsing
 * - consistent error messages
 * - safe fallback when response bodies aren't JSON
 *
 * This module is runtime-agnostic (works in browser + Node runtimes).
 */

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

export type ApiErrorShape = { error?: string } | { message?: string } | Record<string, unknown>;

/**
 * Fetch a JSON endpoint and return parsed JSON.
 *
 * Throws an Error when the response is not ok.
 */
export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  // Centralize temp-user header attach + capture logic.
  const res = await fetchWithTempUser(input, init);

  // Try to parse JSON for both success and error responses.
  const data = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const message =
      extractErrorMessage(data) ||
      `Request failed: ${typeof input === "string" ? input : "fetch"} (${res.status})`;

    // If a user gets logged out mid-session and tries an auth-required action,
    // redirect them back to the home page.
    //
    // Important: We only do this for *authentication* failures (not every 401),
    // because some endpoints use 401 for other flows (e.g. wrong share password).
    if (typeof window !== "undefined" && res.status === 401 && shouldRedirectHomeForAuthFailure(message)) {
      try {
        if (window.location.pathname !== "/") window.location.assign("/");
      } catch {
        // noop: still throw the error below
      }
    }
    throw new Error(message);
  }

  return data as T;
}
/** Return whether a given error message indicates an auth failure that should redirect home. */
function shouldRedirectHomeForAuthFailure(message: string): boolean {
  const m = message.trim().toLowerCase();
  return m === "not authenticated" || m === "unauthorized" || m === "authentication required";
}

/**
 * Attempt to extract a human-friendly error message from common API shapes.
 */
export function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as ApiErrorShape;

  const maybeError = typeof (p as { error?: unknown }).error === "string" ? (p as { error: string }).error : null;
  if (maybeError) return maybeError;

  const maybeMessage =
    typeof (p as { message?: unknown }).message === "string"
      ? (p as { message: string }).message
      : null;
  if (maybeMessage) return maybeMessage;

  return null;
}
