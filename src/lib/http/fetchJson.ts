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

import { captureTempUserFromResponse, withTempUserHeaders } from "@/lib/gating/tempUserClient";

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
  const isBrowser = typeof window !== "undefined";
  const effectiveInit = isBrowser ? withTempUserHeaders(init) : init;
  const res = await fetch(input, effectiveInit);
  if (isBrowser) captureTempUserFromResponse(res);

  // Try to parse JSON for both success and error responses.
  const data = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    const message =
      extractErrorMessage(data) ||
      `Request failed: ${typeof input === "string" ? input : "fetch"} (${res.status})`;
    throw new Error(message);
  }

  return data as T;
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



