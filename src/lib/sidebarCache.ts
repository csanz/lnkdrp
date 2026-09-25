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
  /**
   * The `/api/sidebar` ETag this snapshot came with, so `If-None-Match` is only ever sent for data
   * we actually hold. It used to live in its own localStorage key: when the snapshot write failed or
   * was pruned (quota, private mode) while the key survived, every later refresh got a 304 against a
   * snapshot that no longer matched, and the sidebar stayed wrong through hard reloads (localStorage
   * survives those). Reproduced with a snapshot missing one project and the current ETag.
   */
  etag?: string;
  docs: Paged<SidebarDocListItem>;
  projects: Paged<SidebarProjectListItem>;
  requests: Paged<SidebarProjectListItem>;
  /**
   * Whether the workspace has any activity row at all. Optional: snapshots written before it
   * existed stay valid and simply do not know. Read by `src/lib/client/knownEmpty.ts`.
   */
  activity?: { any: boolean };
};

const STORAGE_KEY_BASE = "lnkdrp-sidebar-cache-v3";
const ETAG_KEY_BASE = "lnkdrp-sidebar-cache-etag-v1";
export const ACTIVE_ORG_STORAGE_KEY = "lnkdrp-active-org-id";
export const ACTIVE_ORG_CHANGED_EVENT = "lnkdrp-active-org-changed";
const MIN_REFRESH_MS = 1500;
/**
 * Orgs whose snapshot this page load fetched in full. `If-None-Match` is only sent after that, and
 * never for a forced refresh: a conditional request can only ever confirm what we already hold, so
 * if the stored snapshot disagrees with the server (a partial write, a snapshot edited by an older
 * build, quota trimming) a 304 would keep it wrong for the life of the browser profile — which is
 * how a project created over MCP stayed missing from the sidebar through hard reloads.
 */
const fullyFetchedOrgs = new Set<string>();

const memByKey = new Map<string, SidebarCacheSnapshot>();
const inFlightByKey = new Map<string, Promise<void>>();
/**
 * A forced refresh asked for while another request was already in flight, queued to run after it.
 * One per org: a burst of forced calls during one in-flight request shares a single follow-up.
 */
const queuedForcedByKey = new Map<string, Promise<void>>();

/** Return whether we're in a browser environment where events/storage are available. */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Normalizes an org id into a canonical 24-hex string (or null).
 *
 * Exists to prevent cross-org cache leakage and to keep cache keys stable.
 */
function normalizeOrgId(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[a-f0-9]{24}$/i.test(s) ? s : null;
}

/**
 * Reads the active org id for client caches from localStorage (best-effort).
 *
 * Exists so non-React modules (like the sidebar cache) can key data correctly before session/org
 * hydration finishes. Returns null when unavailable.
 */
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
    const prev = normalizeOrgId(window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY));
    const next = normalizeOrgId(orgId);
    if (next) window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, next);
    else window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
    if (prev !== next) window.dispatchEvent(new Event(ACTIVE_ORG_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

/**
 * Builds a per-org localStorage key for the sidebar snapshot.
 *
 * Exists to keep multi-workspace data isolated in localStorage.
 */
function storageKeyForOrg(orgId: string | null): string {
  return `${STORAGE_KEY_BASE}:${orgId ?? "anon"}`;
}

/**
 * Builds a per-org localStorage key for the snapshot ETag.
 *
 * Exists to enable conditional GETs for `/api/sidebar` to reduce payloads.
 */
function etagStorageKeyForOrg(orgId: string | null): string {
  return `${ETAG_KEY_BASE}:${orgId ?? "anon"}`;
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
          if (k === ETAG_KEY_BASE || k.startsWith(`${ETAG_KEY_BASE}:`)) {
            window.localStorage.removeItem(k);
          }
        }
      } else {
        window.localStorage.removeItem(storageKeyForOrg(orgId));
        window.localStorage.removeItem(etagStorageKeyForOrg(orgId));
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

/** Fired just before a doc leaves the lists because it was archived or deleted in this tab. */
export const DOC_LEAVING_EVENT = "lnkdrp-doc-leaving";
export type DocLeavingDetail = { docId: string; reason: "archived" | "deleted" };

/**
 * Say why a doc is about to disappear, so the sidebar folds its row out in the matching tint
 * (archived or deleted). Call before `notifyDocsChanged`. Changes made elsewhere (an agent, another
 * tab) get their reason from the realtime activity frame instead.
 */
export function notifyDocLeaving(detail: DocLeavingDetail): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent<DocLeavingDetail>(DOC_LEAVING_EVENT, { detail }));
}

/**
 * Optimistically add a newly-created project to the cached sidebar snapshot.
 *
 * Exists so the left sidebar updates immediately after project creation even if the
 * subsequent `/api/sidebar` refresh is delayed (navigation, debouncing, transient errors).
 *
 * Note: this is best-effort and will be reconciled by `refreshSidebarCache()`.
 */
export function optimisticallyAddProjectToSidebarCache(
  project: SidebarProjectListItem,
  opts?: { orgId?: string | null },
): void {
  const orgId = normalizeOrgId(opts?.orgId) ?? getActiveOrgIdForCaches();
  if (!orgId) return;
  if (!project?.id) return;

  const prev = getSidebarCacheSnapshot({ orgId });
  if (!prev) return;
  // Requests live in a separate section; do not mix.
  if (project.isRequest) return;

  const limit = prev.projects.limit || 10;
  const nowIso = new Date().toISOString();
  const nextItem: SidebarProjectListItem = {
    ...project,
    // Ensure timestamps exist so sorting feels correct even before a server refresh.
    updatedDate: project.updatedDate ?? nowIso,
    createdDate: project.createdDate ?? nowIso,
    isRequest: false,
  };

  const existing = prev.projects.items ?? [];
  if (existing.some((p) => p?.id === nextItem.id)) return;

  const nextItems = [nextItem, ...existing].slice(0, limit);
  const nextTotal = Math.max(prev.projects.total, existing.length) + 1;

  setSidebarCacheSnapshot(
    {
      ...prev,
      updatedAt: Date.now(),
      projects: {
        ...prev.projects,
        items: nextItems,
        total: nextTotal,
      },
    },
    { orgId },
  );
}

/**
 * Refresh the cached snapshot by fetching recent docs/projects from the server.
 *
 * - Debounced via `MIN_REFRESH_MS` unless `force: true`
 * - Coalesces concurrent refresh calls via an `inFlight` promise
 */
/**
 * Read a full `/api/sidebar` response into the cache, keeping its ETag with the snapshot.
 *
 * Verifies the write landed: when localStorage refused it (quota, private mode) the snapshot is kept
 * in memory without an ETag, so the next refresh asks for the whole thing instead of getting a 304
 * it cannot use.
 */
async function storeSnapshot(orgId: string, res: Response): Promise<void> {
  const etag = res.headers.get("etag") ?? "";
  fullyFetchedOrgs.add(orgId);
  // The ETag used to live here on its own; it is part of the snapshot now.
  if (isBrowser()) {
    try {
      window.localStorage.removeItem(etagStorageKeyForOrg(orgId));
    } catch {
      // ignore
    }
  }
  const json = ((await res.json().catch(() => null)) as {
    docs?: Paged<SidebarDocListItem>;
    projects?: Paged<SidebarProjectListItem>;
    requests?: Paged<SidebarProjectListItem>;
    activity?: { any?: unknown };
  } | null) ?? {};

  const next: SidebarCacheSnapshot = {
    updatedAt: Date.now(),
    etag,
    ...(typeof json.activity?.any === "boolean" ? { activity: { any: json.activity.any } } : {}),
    docs: {
      items: Array.isArray(json.docs?.items) ? json.docs!.items : [],
      total: typeof json.docs?.total === "number" ? json.docs.total : 0,
      page: typeof json.docs?.page === "number" ? json.docs.page : 1,
      limit: typeof json.docs?.limit === "number" ? json.docs.limit : 20,
    },
    projects: {
      items: Array.isArray(json.projects?.items) ? json.projects!.items : [],
      total: typeof json.projects?.total === "number" ? json.projects.total : 0,
      page: typeof json.projects?.page === "number" ? json.projects.page : 1,
      limit: typeof json.projects?.limit === "number" ? json.projects.limit : 10,
    },
    requests: {
      items: Array.isArray(json.requests?.items) ? json.requests!.items : [],
      total: typeof json.requests?.total === "number" ? json.requests.total : 0,
      page: typeof json.requests?.page === "number" ? json.requests.page : 1,
      limit: typeof json.requests?.limit === "number" ? json.requests.limit : 10,
    },
  };

  // Avoid noisy re-renders if nothing changed.
  const prev = getSidebarCacheSnapshot({ orgId });
  const same =
    prev &&
    prev.docs.total === next.docs.total &&
    prev.projects.total === next.projects.total &&
    prev.requests.total === next.requests.total &&
    prev.activity?.any === next.activity?.any &&
    JSON.stringify(prev.docs.items) === JSON.stringify(next.docs.items) &&
    JSON.stringify(prev.projects.items) === JSON.stringify(next.projects.items) &&
    JSON.stringify(prev.requests.items) === JSON.stringify(next.requests.items);

  if (!same) {
    setSidebarCacheSnapshot(next, { orgId });
  } else if (prev && (prev.updatedAt !== next.updatedAt || prev.etag !== etag)) {
    // still bump timestamp so we don’t refetch too aggressively
    setSidebarCacheSnapshot({ ...prev, updatedAt: next.updatedAt, etag }, { orgId });
  }

  // Did the ETag actually persist with the data? If localStorage refused the write, keep the
  // snapshot in memory but without an ETag, so the next refresh asks for the whole snapshot.
  if (etag) {
    const stored = readFromStorage(orgId);
    if (stored?.etag !== etag) setSidebarCacheSnapshot({ ...(stored ?? next), etag: "" }, { orgId });
  }
}

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
  if (inFlight) {
    // Coalesce concurrent unforced calls onto the request already running.
    if (!force) return inFlight;
    /**
     * A forced call means "something just changed; the list you are fetching may already be
     * stale". Handing it the in-flight promise let a delete resurrect its document: the sidebar
     * request started before the delete, the delete's forced refresh coalesced onto it, and the
     * response that arrived was the pre-delete list, stored as current (review M34). So a forced
     * call during a request queues one more fetch to run after it, shared by every forced call
     * that arrives while the first is still in flight.
     */
    const queued = queuedForcedByKey.get(key);
    if (queued) return queued;
    const followUp: Promise<void> = inFlight
      .catch(() => undefined)
      .then(() => refreshSidebarCache({ force: true, reason: `${reason}:after-in-flight` }))
      .finally(() => {
        if (queuedForcedByKey.get(key) === followUp) queuedForcedByKey.delete(key);
      });
    queuedForcedByKey.set(key, followUp);
    return followUp;
  }

  const run = (async () => {
    try {
      // Only the ETag stored with this snapshot, and only once this page load has read it in full.
      const etag = !force && fullyFetchedOrgs.has(orgId) ? (snap?.etag ?? "") : "";
      const res = await fetchWithTempUser(`/api/sidebar?sidebar=1`, {
        cache: "no-store",
        headers: etag ? { "if-none-match": etag } : undefined,
      });

      // 304 means "no change"; still bump timestamp so we don't refetch too aggressively.
      if (res.status === 304) {
        const prev = getSidebarCacheSnapshot({ orgId });
        if (prev) {
          setSidebarCacheSnapshot({ ...prev, updatedAt: Date.now() }, { orgId });
          return;
        }
        // Nothing to pair the ETag with: ask again for the whole snapshot.
        const full = await fetchWithTempUser(`/api/sidebar?sidebar=1`, { cache: "no-store" });
        if (!full.ok) return;
        await storeSnapshot(orgId, full);
        return;
      }

      // A failed request must not overwrite a good snapshot with empty lists.
      if (!res.ok) return;
      await storeSnapshot(orgId, res);
    } catch {
      // ignore (best-effort)
    } finally {
      // eslint-disable-next-line no-console
      void reason;
    }
  })();

  // Track the *wrapped* promise and compare against that same reference on release. The map used
  // to hold `run.finally(...)` while the release check compared to `run`, so the entry was never
  // removed: after the first refresh every later call (realtime frames included) returned the stale
  // settled promise and never fetched, and the sidebar stopped updating until a reload.
  const tracked: Promise<void> = run.finally(() => {
    if (inFlightByKey.get(key) === tracked) inFlightByKey.delete(key);
  });
  inFlightByKey.set(key, tracked);
  return tracked;
}
