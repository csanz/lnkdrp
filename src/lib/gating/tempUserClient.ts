/**
 * Client-side persistence + header helpers for "temp users".
 *
 * A temp user is a lightweight identity stored in localStorage and sent as headers
 * on API requests. It enables gated flows (request/share uploads) without requiring
 * full authentication.
 */
import { TEMP_USER_ID_HEADER, TEMP_USER_SECRET_HEADER } from "@/lib/gating/tempUserHeaders";
export const TEMP_USER_STORAGE_KEY = "lnkdrp_temp_user";

export type TempUserStored = { id: string; secret: string };

/** Return whether we have access to `window` and `localStorage`. */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** Read the stored temp user from localStorage (returns null if missing/invalid). */
export function getTempUser(): TempUserStored | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(TEMP_USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const id = (parsed as { id?: unknown }).id;
    const secret = (parsed as { secret?: unknown }).secret;
    if (typeof id !== "string" || !id) return null;
    if (typeof secret !== "string" || !secret) return null;
    return { id, secret };
  } catch {
    return null;
  }
}

/** Persist the given temp user to localStorage (best-effort). */
export function setTempUser(next: TempUserStored): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(TEMP_USER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

/** Remove any stored temp user from localStorage (best-effort). */
export function clearTempUser(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(TEMP_USER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Normalize `HeadersInit` into a mutable `Headers` instance. */
function normalizeHeaders(h: HeadersInit | undefined): Headers {
  if (h instanceof Headers) return new Headers(h);
  return new Headers(h ?? undefined);
}

/**
 * Add temp-user headers to a `fetch` init object.
 * Does not overwrite headers if the caller already set them explicitly.
 */
export function withTempUserHeaders(init?: RequestInit): RequestInit {
  const tu = getTempUser();
  if (!tu) return init ?? {};

  const headers = normalizeHeaders(init?.headers);
  // Do not overwrite if caller already set them explicitly.
  if (!headers.has(TEMP_USER_ID_HEADER)) headers.set(TEMP_USER_ID_HEADER, tu.id);
  if (!headers.has(TEMP_USER_SECRET_HEADER)) headers.set(TEMP_USER_SECRET_HEADER, tu.secret);

  return { ...(init ?? {}), headers };
}

/**
 * Capture temp-user headers from a response and persist them to localStorage.
 * This is how the browser learns about a newly-created temp user.
 */
export function captureTempUserFromResponse(res: Response): void {
  if (!isBrowser()) return;
  const id = res.headers.get(TEMP_USER_ID_HEADER);
  const secret = res.headers.get(TEMP_USER_SECRET_HEADER);
  if (id && secret) setTempUser({ id, secret });
}

/**
 * Convenience wrapper for `fetch` that:
 * - includes temp-user headers on the request, and
 * - captures any updated temp-user headers from the response.
 */
export async function fetchWithTempUser(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, withTempUserHeaders(init));
  captureTempUserFromResponse(res);
  return res;
}

