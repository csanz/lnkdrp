/**
 * useJsonFetch — GET a JSON endpoint with the temp-user headers, no HTTP cache, and abort on
 * url change or unmount. A 402 (plan limit) only sets `status`, so callers can open the upgrade
 * modal instead of showing an error.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

export type JsonFetchState<T> = {
  data: T | null;
  /** Message for a failed request; null on success, while loading, and for 402. */
  error: string | null;
  /** HTTP status of the last finished request; null before it finishes or on a network error. */
  status: number | null;
  loading: boolean;
  retry: () => void;
};

type Settled<T> = { url: string; attempt: number; data: T | null; error: string | null; status: number | null };

export type JsonFetchOptions = {
  /** Keep returning the last successful data while a new url or retry loads (avoids skeleton flashes on refresh). */
  keepPrevious?: boolean;
};

/** Fetch `url` as JSON (null url = idle), re-fetching when the url changes or `retry` is called. */
export function useJsonFetch<T>(url: string | null, options: JsonFetchOptions = {}): JsonFetchState<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [lastGood, setLastGood] = useState<T | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const finish = (next: Omit<Settled<T>, "url" | "attempt">) => {
      if (controller.signal.aborted) return;
      setSettled({ url, attempt, ...next });
      if (next.data !== null) setLastGood(next.data);
    };
    (async () => {
      try {
        const res = await fetchWithTempUser(url, { cache: "no-store", signal: controller.signal });
        if (res.status === 402) {
          finish({ data: null, error: null, status: 402 });
          return;
        }
        const body = (await res.json().catch(() => null)) as unknown;
        if (!res.ok) {
          const message =
            body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Request failed (${res.status})`;
          finish({ data: null, error: message, status: res.status });
          return;
        }
        finish({ data: body as T, error: null, status: res.status });
      } catch (err) {
        if (controller.signal.aborted) return;
        finish({ data: null, error: err instanceof Error ? err.message : "Request failed", status: null });
      }
    })();
    return () => controller.abort();
  }, [url, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Results from an earlier url or attempt are never shown for the current one.
  const current = settled && url && settled.url === url && settled.attempt === attempt ? settled : null;
  const loading = Boolean(url) && !current;
  return {
    data: current?.data ?? (loading && options.keepPrevious ? lastGood : null),
    error: current?.error ?? null,
    status: current?.status ?? null,
    loading,
    retry,
  };
}

export default useJsonFetch;
