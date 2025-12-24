"use client";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

export const PROJECTS_CHANGED_EVENT = "lnkdrp-projects-changed";
export const DOCS_CHANGED_EVENT = "lnkdrp-docs-changed";
export const SIDEBAR_CACHE_UPDATED_EVENT = "lnkdrp-sidebar-cache-updated";

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

export type SidebarDocListItem = {
  id: string;
  shareId: string | null;
  title: string;
  status: string | null;
  version: number | null;
  updatedDate: string | null;
  createdDate: string | null;
};

export type SidebarProjectListItem = {
  id: string;
  name: string;
  slug: string;
  description: string;
  updatedDate: string | null;
  createdDate: string | null;
};

export type SidebarCacheSnapshot = {
  updatedAt: number;
  docs: Paged<SidebarDocListItem>;
  projects: Paged<SidebarProjectListItem>;
};

const STORAGE_KEY = "lnkdrp-sidebar-cache-v1";
const MIN_REFRESH_MS = 1500;

let mem: SidebarCacheSnapshot | null = null;
let inFlight: Promise<void> | null = null;

function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function safeParseSnapshot(raw: string | null): SidebarCacheSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SidebarCacheSnapshot;
    if (!v || typeof v !== "object") return null;
    if (typeof (v as SidebarCacheSnapshot).updatedAt !== "number") return null;
    if (!(v as SidebarCacheSnapshot).docs || !(v as SidebarCacheSnapshot).projects) return null;
    return v;
  } catch {
    return null;
  }
}

function readFromStorage(): SidebarCacheSnapshot | null {
  if (!isBrowser()) return null;
  try {
    return safeParseSnapshot(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeToStorage(snapshot: SidebarCacheSnapshot) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore (quota / private mode)
  }
}

function emitUpdated() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(SIDEBAR_CACHE_UPDATED_EVENT));
}

export function getSidebarCacheSnapshot(): SidebarCacheSnapshot | null {
  if (mem) return mem;
  const stored = readFromStorage();
  if (stored) mem = stored;
  return stored;
}

export function setSidebarCacheSnapshot(snapshot: SidebarCacheSnapshot) {
  mem = snapshot;
  writeToStorage(snapshot);
  emitUpdated();
}

export function notifyProjectsChanged() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
}

export function notifyDocsChanged() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(DOCS_CHANGED_EVENT));
}

export async function refreshSidebarCache(opts?: { force?: boolean; reason?: string }) {
  const force = Boolean(opts?.force);
  const reason = opts?.reason ?? "refresh";

  const snap = getSidebarCacheSnapshot();
  const now = Date.now();
  const recentlyRefreshed = snap && now - snap.updatedAt < MIN_REFRESH_MS;

  if (!force && recentlyRefreshed) return;
  if (inFlight && !force) return inFlight;

  const run = (async () => {
    try {
      const [dRes, pRes] = await Promise.all([
        fetchWithTempUser(`/api/docs?limit=4&page=1`, { cache: "no-store" }),
        fetchWithTempUser(`/api/projects?limit=5&page=1`, { cache: "no-store" }),
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

      const next: SidebarCacheSnapshot = {
        updatedAt: Date.now(),
        docs: {
          items: Array.isArray(dJson.docs) ? dJson.docs : [],
          total: typeof dJson.total === "number" ? dJson.total : 0,
          page: typeof dJson.page === "number" ? dJson.page : 1,
          limit: typeof dJson.limit === "number" ? dJson.limit : 4,
        },
        projects: {
          items: Array.isArray(pJson.projects) ? pJson.projects : [],
          total: typeof pJson.total === "number" ? pJson.total : 0,
          page: typeof pJson.page === "number" ? pJson.page : 1,
          limit: typeof pJson.limit === "number" ? pJson.limit : 5,
        },
      };

      // Avoid noisy re-renders if nothing changed.
      const prev = getSidebarCacheSnapshot();
      const same =
        prev &&
        prev.docs.total === next.docs.total &&
        prev.projects.total === next.projects.total &&
        JSON.stringify(prev.docs.items) === JSON.stringify(next.docs.items) &&
        JSON.stringify(prev.projects.items) === JSON.stringify(next.projects.items);

      if (!same) {
        setSidebarCacheSnapshot(next);
      } else if (prev && prev.updatedAt !== next.updatedAt) {
        // still bump timestamp so we don’t refetch too aggressively
        setSidebarCacheSnapshot({ ...prev, updatedAt: next.updatedAt });
      }
    } catch {
      // ignore (best-effort)
    } finally {
      // eslint-disable-next-line no-console
      void reason;
    }
  })();

  inFlight = run.finally(() => {
    if (inFlight === run) inFlight = null;
  });

  return inFlight;
}


