/**
 * Client-side "starred documents" cache + optimistic helpers.
 *
 * Source of truth: MongoDB (`StarredDoc` model).
 * Cache: browser localStorage (for fast UX + offline-ish behavior).
 *
 * The helpers below:
 * - read/write the local cache (synchronously) for snappy UI
 * - best-effort sync changes to the server in the background
 * - emit a window event whenever the cache changes so the UI can update reactively
 */
import { ACTIVE_ORG_STORAGE_KEY } from "@/lib/sidebarCache";

export type StarredDoc = {
  id: string;
  title: string;
  starredAt: number;
  /** Ordering key; lower sorts earlier. May be missing in legacy local cache entries. */
  sortKey?: number;
  /** Cached doc version for fast sidebar rendering (best-effort). */
  version?: number | null;
  /** Cached doc status for fast sidebar rendering (best-effort). */
  status?: string | null;
};

const STORAGE_KEY_BASE = "lnkdrp-starred-docs-v2";
const LEGACY_STORAGE_KEY = "lnkdrp.starredDocs.v1";
const BOOTSTRAP_DONE_KEY_BASE = "lnkdrp.starred.bootstrap.v1";
/** Window event fired when the starred-docs cache changes. */
export const STARRED_DOCS_CHANGED_EVENT = "lnkdrp:starred-docs-changed";
/**
 * Parse JSON input (best-effort) and return null when invalid.
 */


function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
/** Normalize untrusted data into a `StarredDoc[]` list. */
function normalizeStarredDocs(value: unknown): StarredDoc[] {
  if (!Array.isArray(value)) return [];
  const out: StarredDoc[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const o = v as {
      id?: unknown;
      title?: unknown;
      starredAt?: unknown;
      sortKey?: unknown;
      version?: unknown;
      status?: unknown;
    };
    if (typeof o.id !== "string" || !o.id) continue;
    if (typeof o.title !== "string") continue;
    const starredAt = typeof o.starredAt === "number" && Number.isFinite(o.starredAt) ? o.starredAt : 0;
    const sortKey = typeof o.sortKey === "number" && Number.isFinite(o.sortKey) ? o.sortKey : undefined;
    const version = typeof o.version === "number" && Number.isFinite(o.version) ? o.version : o.version === null ? null : undefined;
    const status = typeof o.status === "string" ? o.status : o.status === null ? null : undefined;
    out.push({
      id: o.id,
      title: o.title,
      starredAt,
      ...(typeof sortKey === "number" ? { sortKey } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }
  return out;
}
/**
 * Reads the active org id used for client caches (best-effort).
 *
 * Exists to prevent cross-org cache leakage; assumes `window` is available.
 */
function getActiveOrgIdUnsafe(): string | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    const s = typeof raw === "string" ? raw.trim() : "";
    return /^[a-f0-9]{24}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Computes the localStorage key for starred docs scoped to the active org.
 *
 * Returns null until org context is available (to avoid flashing stale data).
 */
function storageKeyForActiveOrgUnsafe(): string | null {
  const orgId = getActiveOrgIdUnsafe();
  if (!orgId) return null;
  return `${STORAGE_KEY_BASE}:${orgId}`;
}

/**
 * Computes the localStorage key used to mark "bootstrap to server" as done for the active org.
 *
 * Exists to avoid repeatedly replaying legacy local stars into MongoDB.
 */
function bootstrapDoneKeyForActiveOrgUnsafe(): string | null {
  const orgId = getActiveOrgIdUnsafe();
  if (!orgId) return null;
  return `${BOOTSTRAP_DONE_KEY_BASE}:${orgId}`;
}

/**
 * Reads starred docs from localStorage for the active org.
 *
 * Assumes `window` exists; returns an empty list when org keying isn't available.
 */
function readStarredDocsUnsafe(): StarredDoc[] {
  const key = storageKeyForActiveOrgUnsafe();
  // If we don't know the active org yet, don't read any cache (prevents stale cross-org flash).
  if (!key) return [];
  const raw = window.localStorage.getItem(key);
  if (!raw) return [];
  return normalizeStarredDocs(safeParseJson(raw));
}
/**
 * Persists starred docs to localStorage for the active org and emits a change event.
 *
 * Side effects: removes legacy unscoped storage to reduce future ambiguity.
 */
function writeStarredDocsUnsafe(next: StarredDoc[]): void {
  const key = storageKeyForActiveOrgUnsafe();
  if (!key) return;
  window.localStorage.setItem(key, JSON.stringify(next));
  // Best-effort: stop writing to legacy unscoped storage.
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(STARRED_DOCS_CHANGED_EVENT));
}

/**
 * Fetches starred docs from the server (MongoDB source of truth).
 *
 * Returns null on network/parse errors; never throws to callers.
 */
async function fetchStarredFromServer(): Promise<StarredDoc[] | null> {
  try {
    const res = await fetch("/api/starred", { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    const docs = (json && typeof json === "object" && "docs" in json ? (json as { docs?: unknown }).docs : []) ?? [];
    return normalizeStarredDocs(docs);
  } catch {
    return null;
  }
}

/**
 * Refresh the local starred cache from the server (MongoDB source of truth).
 * This is best-effort and never throws.
 */
export async function refreshStarredDocsFromServer(opts?: { bootstrap?: boolean }): Promise<StarredDoc[]> {
  if (typeof window === "undefined") return [];
  // If we don't know active org yet, don't fetch (avoids cross-org flash).
  if (!storageKeyForActiveOrgUnsafe()) return getStarredDocs();

  const shouldBootstrap = Boolean(opts?.bootstrap);
  if (shouldBootstrap) {
    try {
      const doneKey = bootstrapDoneKeyForActiveOrgUnsafe();
      const done = doneKey ? window.localStorage.getItem(doneKey) === "1" : false;
      if (!done) {
        const local = getStarredDocs();
        if (local.length) {
          // If server is empty (or unreachable), we still try bootstrap once; the server
          // will ignore duplicates thanks to unique (orgId,userId,docId).
          await fetch("/api/starred/bootstrap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              docs: local.map((d, idx) => ({
                docId: d.id,
                title: d.title,
                starredAt: d.starredAt,
                sortKey: typeof d.sortKey === "number" ? d.sortKey : idx,
              })),
            }),
          }).catch(() => null);
        }
        if (doneKey) window.localStorage.setItem(doneKey, "1");
      }
    } catch {
      // ignore
    }
  }

  const serverDocs = await fetchStarredFromServer();
  if (!serverDocs) return getStarredDocs();
  try {
    writeStarredDocsUnsafe(serverDocs);
  } catch {
    // ignore
  }
  return serverDocs;
}
/**
 * Returns the current starred docs list from the local cache.
 *
 * Exists for instant UI reads; source of truth remains the server.
 * Returns an empty list during SSR or when localStorage is unavailable.
 */
export function getStarredDocs(): StarredDoc[] {
  if (typeof window === "undefined") return [];
  try {
    // Preserve the stored order (new stars are inserted at the top by `toggleStarredDoc`).
    // This enables manual ordering (e.g. move up/down in the Starred UI).
    return readStarredDocsUnsafe();
  } catch {
    return [];
  }
}
/** Return whether the given doc id is currently starred. */
export function isDocStarred(docId: string): boolean {
  if (!docId) return false;
  return getStarredDocs().some((d) => d.id === docId);
}
/**
 * Optimistically toggles a doc in the local starred cache and syncs to the server.
 *
 * Exists for snappy UX: the local cache updates immediately, while the server update is best-effort.
 * Side effects: emits `STARRED_DOCS_CHANGED_EVENT` and may overwrite local state with server truth.
 */
export function toggleStarredDoc(doc: { id: string; title: string }): { starred: boolean; docs: StarredDoc[] } {
  if (typeof window === "undefined") return { starred: false, docs: [] };
  try {
    const prev = readStarredDocsUnsafe();
    const exists = prev.some((d) => d.id === doc.id);
    const next = exists
      ? prev.filter((d) => d.id !== doc.id)
      : [
          {
            id: doc.id,
            title: doc.title || "Document",
            starredAt: Date.now(),
            sortKey: (prev[0]?.sortKey ?? 0) - 1,
          },
          ...prev,
        ];
    writeStarredDocsUnsafe(next);

    // Best-effort persist to server (do not block UI).
    void (async () => {
      try {
        const res = await fetch("/api/starred", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docId: doc.id, title: doc.title || "Document" }),
        });
        if (!res.ok) return;
        const json = (await res.json()) as unknown;
        const docs = (json && typeof json === "object" && "docs" in json ? (json as { docs?: unknown }).docs : []) ?? [];
        const normalized = normalizeStarredDocs(docs);
        if (normalized.length || exists) writeStarredDocsUnsafe(normalized);
      } catch {
        // ignore
      }
    })();

    return { starred: !exists, docs: next };
  } catch {
    return { starred: false, docs: [] };
  }
}
/**
 * Updates the cached title for a starred doc (local-only).
 *
 * Exists to keep the starred list readable when doc titles change without forcing a full refresh.
 */
/** Update the stored title for a starred doc (no-op if the doc is not starred). */
export function upsertStarredDocTitle(doc: { id: string; title: string }): void {
  if (typeof window === "undefined") return;
  try {
    const prev = readStarredDocsUnsafe();
    const idx = prev.findIndex((d) => d.id === doc.id);
    if (idx < 0) return;
    const cur = prev[idx];
    if (cur.title === doc.title) return;
    const next = prev.slice();
    next[idx] = { ...cur, title: doc.title };
    writeStarredDocsUnsafe(next);
  } catch {
    // ignore
  }
}

/**
 * Best-effort upsert of cached doc meta (version/status) for a starred doc.
 * This is used to make the left menu "v#" pills render instantly without waiting for `/api/docs?ids=...`.
 */
export function upsertStarredDocMeta(doc: { id: string; version?: number | null; status?: string | null }): void {
  if (typeof window === "undefined") return;
  const id = (doc.id ?? "").trim();
  if (!id) return;
  try {
    const prev = readStarredDocsUnsafe();
    const idx = prev.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const cur = prev[idx]!;

    const nextVersion =
      typeof doc.version === "number" && Number.isFinite(doc.version) ? doc.version : doc.version === null ? null : undefined;
    const nextStatus = typeof doc.status === "string" ? doc.status : doc.status === null ? null : undefined;

    const noChange =
      (nextVersion === undefined || cur.version === nextVersion) && (nextStatus === undefined || cur.status === nextStatus);
    if (noChange) return;

    const next = prev.slice();
    next[idx] = {
      ...cur,
      ...(nextVersion !== undefined ? { version: nextVersion } : {}),
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
    };
    writeStarredDocsUnsafe(next);
  } catch {
    // ignore
  }
}
/**
 * Reorders a starred doc locally and syncs the new order to the server (best-effort).
 *
 * Side effects: rewrites local `sortKey` values to match the new order and emits a change event.
 */
export function moveStarredDoc(docId: string, dir: "up" | "down"): { docs: StarredDoc[]; moved: boolean } {
  if (typeof window === "undefined") return { docs: [], moved: false };
  const id = (docId ?? "").trim();
  if (!id) return { docs: getStarredDocs(), moved: false };
  try {
    const prev = readStarredDocsUnsafe();
    const idx = prev.findIndex((d) => d.id === id);
    if (idx < 0) return { docs: prev, moved: false };
    const nextIdx = dir === "up" ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= prev.length) return { docs: prev, moved: false };
    const next = prev.slice();
    const tmp = next[idx];
    next[idx] = next[nextIdx]!;
    next[nextIdx] = tmp!;
    // Normalize sortKeys to match the new order (stable for server reorder).
    const withKeys = next.map((d, i) => ({ ...d, sortKey: i }));
    writeStarredDocsUnsafe(withKeys);

    // Best-effort persist reorder to server.
    void (async () => {
      try {
        const res = await fetch("/api/starred", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ docIds: withKeys.map((d) => d.id) }),
        });
        if (!res.ok) return;
        const json = (await res.json()) as unknown;
        const docs = (json && typeof json === "object" && "docs" in json ? (json as { docs?: unknown }).docs : []) ?? [];
        const normalized = normalizeStarredDocs(docs);
        if (normalized.length) writeStarredDocsUnsafe(normalized);
      } catch {
        // ignore
      }
    })();
    return { docs: withKeys, moved: true };
  } catch {
    return { docs: getStarredDocs(), moved: false };
  }
}
