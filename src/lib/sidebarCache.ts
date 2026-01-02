"use client";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/**
 * Client-side sidebar cache.
 *
 * The sidebar needs quick access to recent docs/projects. We maintain a small
 * snapshot in memory + localStorage and expose helpers to:
 * - read/write the snapshot
 * - notify other tabs/components of changes via window events
 * - refresh from server (best-effort, debounced)
 */

/** Window event fired when projects lists should be refreshed. */
export const PROJECTS_CHANGED_EVENT = "lnkdrp-projects-changed";
/** Window event fired when docs lists should be refreshed. */
export const DOCS_CHANGED_EVENT = "lnkdrp-docs-changed";
/** Window event fired when the cached snapshot has been updated. */
export const SIDEBAR_CACHE_UPDATED_EVENT = "lnkdrp-sidebar-cache-updated";

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

export type SidebarDocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  status: string | null;
  version: number | null;
  /** If set, this doc was originally received via a request repo (Project id). */
  receivedViaRequestProjectId?: string | null;
  /** If set, this doc is being used as a guide for a request repo (Project id). */
  guideForRequestProjectId?: string | null;
  updatedDate: string | null;
  createdDate: string | null;
};

export type SidebarProjectListItem = {
  id: string;
  name: string;
  slug: string;
  description: string;
  isRequest?: boolean;
  docCount?: number;
  updatedDate: string | null;
  createdDate: string | null;
};

export type SidebarCacheSnapshot = {
  updatedAt: number;
  docs: Paged<SidebarDocListItem>;
  projects: Paged<SidebarProjectListItem>;
  requests: Paged<SidebarProjectListItem>;
};

const STORAGE_KEY_BASE = "lnkdrp-sidebar-cache-v3";
export const ACTIVE_ORG_STORAGE_KEY = "lnkdrp-active-org-id";
const MIN_REFRESH_MS = 1500;

let memByKey = new Map<string, SidebarCacheSnapshot>();
let inFlightByKey = new Map<string, Promise<void>>();

/** Return whether we're in a browser environment where events/storage are available. */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function normalizeOrgId(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[a-f0-9]{24}$/i.test(s) ? s : null;
}

function getActiveOrgIdForCaches(): string | null {
  if (!isBrowser()) return null;
  try {
    return normalizeOrgId(window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Set the active org id used by client caches (sidebar cache keying).
 *
 * This is best-effort and is synced from the authenticated session in `src/app/providers.tsx`.
 */
export function setActiveOrgIdForCaches(orgId: string | null): void {
  if (!isBrowser()) return;
  try {
    if (orgId && normalizeOrgId(orgId)) window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
    else window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function storageKeyForOrg(orgId: string | null): string {
  return `${STORAGE_KEY_BASE}:${orgId ?? "anon"}`;
}

/** Return whether a value looks like a valid SidebarCacheSnapshot (best-effort). */
function isValidSnapshot(v: unknown): v is SidebarCacheSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as SidebarCacheSnapshot;
  return (
    typeof s.updatedAt === "number" &&
    Boolean(s.docs) &&
    Boolean(s.projects) &&
    Boolean(s.requests)
  );
}

/** Parse a stored snapshot and return null when invalid/corrupt. */
function safeParseSnapshot(raw: string | null): SidebarCacheSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SidebarCacheSnapshot;
    return isValidSnapshot(v) ? v : null;
  } catch {
    return null;
  }
}

/** Read the sidebar cache snapshot from localStorage (best-effort). */
function readFromStorage(orgId: string | null): SidebarCacheSnapshot | null {
  if (!isBrowser()) return null;
  try {
    const key = storageKeyForOrg(orgId);
    return safeParseSnapshot(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Persist the sidebar cache snapshot to localStorage (best-effort). */
function writeToStorage(orgId: string | null, snapshot: SidebarCacheSnapshot): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(storageKeyForOrg(orgId), JSON.stringify(snapshot));
  } catch {
    // ignore (quota / private mode)
  }
}

/** Emit a window event indicating the cache snapshot changed. */
function emitUpdated(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(SIDEBAR_CACHE_UPDATED_EVENT));
}

/** Return the current cache snapshot, preferring in-memory over localStorage. */
export function getSidebarCacheSnapshot(opts?: { orgId?: string | null }): SidebarCacheSnapshot | null {
  const orgId = normalizeOrgId(opts?.orgId) ?? getActiveOrgIdForCaches();
  // If we don't know the active org yet, do not read any cache. This prevents the UI
  // from briefly showing stale data from another org while auth/org context hydrates.
  if (!orgId) return null;
  const key = storageKeyForOrg(orgId);

  const mem = memByKey.get(key) ?? null;
  if (mem && isValidSnapshot(mem)) return mem;
  if (mem && !isValidSnapshot(mem)) memByKey.delete(key);

  const stored = readFromStorage(orgId);
  if (stored) memByKey.set(key, stored);
  return stored;
}

/** Update the in-memory + persisted cache snapshot and notify listeners. */
export function setSidebarCacheSnapshot(snapshot: SidebarCacheSnapshot, opts?: { orgId?: string | null }): void {
  const orgId = normalizeOrgId(opts?.orgId) ?? getActiveOrgIdForCaches();
  if (!orgId) return;
  const key = storageKeyForOrg(orgId);
  memByKey.set(key, snapshot);
  writeToStorage(orgId, snapshot);
  emitUpdated();
}

/**
 * Clear the sidebar cache (in-memory + persisted localStorage) and notify listeners.
 *
 * This is useful for debugging cases where a stale in-memory snapshot survives hot reloads.
 */
export function clearSidebarCache(opts?: { orgId?: string | null; memoryOnly?: boolean; all?: boolean }): void {
  const orgId = normalizeOrgId(opts?.orgId) ?? getActiveOrgIdForCaches();
  const key = storageKeyForOrg(orgId);
  memByKey.delete(key);
  if (opts?.memoryOnly) {
    emitUpdated();
    return;
  }
  if (isBrowser()) {
    try {
      if (opts?.all) {
        // Clear all per-org cache entries.
        const keys = Object.keys(window.localStorage);
        for (const k of keys) {
          if (k === STORAGE_KEY_BASE || k.startsWith(`${STORAGE_KEY_BASE}:`)) {
            window.localStorage.removeItem(k);
          }
        }
      } else {
        window.localStorage.removeItem(storageKeyForOrg(orgId));
      }
      // Best-effort: clear legacy keys as well.
      window.localStorage.removeItem(STORAGE_KEY_BASE);
      window.localStorage.removeItem("lnkdrp-sidebar-cache-v2");
    } catch {
      // ignore
    }
  }
  emitUpdated();
}

/** Notify listeners that projects may have changed (best-effort). */
export function notifyProjectsChanged(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
}

/** Notify listeners that docs may have changed (best-effort). */
export function notifyDocsChanged(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(DOCS_CHANGED_EVENT));
}

/**
 * Refresh the cached snapshot by fetching recent docs/projects from the server.
 *
 * - Debounced via `MIN_REFRESH_MS` unless `force: true`
 * - Coalesces concurrent refresh calls via an `inFlight` promise
 */
export async function refreshSidebarCache(opts?: { force?: boolean; reason?: string }): Promise<void> {
  const force = Boolean(opts?.force);
  const reason = opts?.reason ?? "refresh";

  const orgId = getActiveOrgIdForCaches();
  // Don't fetch until we know the org context; avoids flashing data from another org.
  if (!orgId) return;
  const key = storageKeyForOrg(orgId);

  const snap = getSidebarCacheSnapshot({ orgId });
  const now = Date.now();
  const recentlyRefreshed = snap && now - snap.updatedAt < MIN_REFRESH_MS;

  if (!force && recentlyRefreshed) return;
  const inFlight = inFlightByKey.get(key) ?? null;
  if (inFlight && !force) return inFlight;

  const run = (async () => {
    try {
      const [dRes, pRes, rRes] = await Promise.all([
        fetchWithTempUser(`/api/docs?limit=5&page=1`, { cache: "no-store" }),
        fetchWithTempUser(`/api/projects?limit=10&page=1`, { cache: "no-store" }),
        fetchWithTempUser(`/api/requests?limit=10&page=1`, { cache: "no-store" }),
      ]);

      const dJson = dRes.ok
        ? ((await dRes.json()) as {
            docs?: SidebarDocListItem[];
            total?: number;
            page?: number;
            limit?: number;
          })
        : {};
      const pJson = pRes.ok
        ? ((await pRes.json()) as {
            projects?: SidebarProjectListItem[];
            total?: number;
            page?: number;
            limit?: number;
          })
        : {};
      const rJson = rRes.ok
        ? ((await rRes.json()) as {
            items?: SidebarProjectListItem[];
            total?: number;
            page?: number;
            limit?: number;
          })
        : {};

      const next: SidebarCacheSnapshot = {
        updatedAt: Date.now(),
        docs: {
          items: Array.isArray(dJson.docs) ? dJson.docs : [],
          total: typeof dJson.total === "number" ? dJson.total : 0,
          page: typeof dJson.page === "number" ? dJson.page : 1,
          limit: typeof dJson.limit === "number" ? dJson.limit : 5,
        },
        projects: {
          items: Array.isArray(pJson.projects) ? pJson.projects : [],
          total: typeof pJson.total === "number" ? pJson.total : 0,
          page: typeof pJson.page === "number" ? pJson.page : 1,
          limit: typeof pJson.limit === "number" ? pJson.limit : 10,
        },
        requests: {
          items: Array.isArray(rJson.items) ? rJson.items : [],
          total: typeof rJson.total === "number" ? rJson.total : 0,
          page: typeof rJson.page === "number" ? rJson.page : 1,
          limit: typeof rJson.limit === "number" ? rJson.limit : 10,
        },
      };

      // Avoid noisy re-renders if nothing changed.
      const prev = getSidebarCacheSnapshot({ orgId });
      const same =
        prev &&
        prev.docs.total === next.docs.total &&
        prev.projects.total === next.projects.total &&
        prev.requests.total === next.requests.total &&
        JSON.stringify(prev.docs.items) === JSON.stringify(next.docs.items) &&
        JSON.stringify(prev.projects.items) === JSON.stringify(next.projects.items) &&
        JSON.stringify(prev.requests.items) === JSON.stringify(next.requests.items);

      if (!same) {
        setSidebarCacheSnapshot(next, { orgId });
      } else if (prev && prev.updatedAt !== next.updatedAt) {
        // still bump timestamp so we don’t refetch too aggressively
        setSidebarCacheSnapshot({ ...prev, updatedAt: next.updatedAt }, { orgId });
      }
    } catch {
      // ignore (best-effort)
    } finally {
      // eslint-disable-next-line no-console
      void reason;
    }
  })();

  inFlightByKey.set(
    key,
    run.finally(() => {
      if (inFlightByKey.get(key) === run) inFlightByKey.delete(key);
    }),
  );

  return inFlightByKey.get(key);
}
