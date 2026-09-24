"use client";

/**
 * The last payload each page saw, per workspace, for the life of the tab.
 *
 * Every list page fetched from scratch on every visit: leave Activity for Metrics and come back,
 * and Activity drew a skeleton for a feed it had on screen two seconds ago. This keeps the last
 * response in memory so the page paints it at once and refreshes underneath (the pages already
 * have a "pending" bar for exactly that). Memory only, never storage: a payload can carry names
 * and titles, and a tab's lifetime is the right lifetime for a cache whose only job is to make
 * the second visit instant.
 *
 * Keyed by the active workspace, read from the same storage key the sidebar cache uses, so a
 * workspace switch can never paint the previous workspace's rows.
 */
import { ACTIVE_ORG_STORAGE_KEY } from "@/lib/sidebarCache";

const cache = new Map<string, unknown>();

function activeOrgId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function fullKey(key: string): string | null {
  const org = activeOrgId();
  return org ? `${org}:${key}` : null;
}

/** The cached payload for `key` in the active workspace, or `null`. */
export function readPageCache<T>(key: string): T | null {
  const k = fullKey(key);
  if (!k) return null;
  return (cache.get(k) as T | undefined) ?? null;
}

/** Remember `value` as the latest payload for `key` in the active workspace. */
export function writePageCache<T>(key: string, value: T): void {
  const k = fullKey(key);
  if (!k) return;
  cache.set(k, value);
}

/** Forget every cached payload whose key starts with `prefix`, in the active workspace. */
export function clearPageCache(prefix: string): void {
  const org = activeOrgId();
  if (!org) return;
  const head = `${org}:${prefix}`;
  for (const k of cache.keys()) if (k.startsWith(head)) cache.delete(k);
}
