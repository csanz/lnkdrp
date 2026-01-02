/**
 * Client-side "starred documents" persistence.
 *
 * Stores a small list of starred docs in localStorage and emits a window event
 * whenever the list changes so the UI can update reactively.
 */
import { ACTIVE_ORG_STORAGE_KEY } from "@/lib/sidebarCache";

export type StarredDoc = {
  id: string;
  title: string;
  starredAt: number;
};

const STORAGE_KEY_BASE = "lnkdrp-starred-docs-v2";
const LEGACY_STORAGE_KEY = "lnkdrp.starredDocs.v1";
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
    const o = v as { id?: unknown; title?: unknown; starredAt?: unknown };
    if (typeof o.id !== "string" || !o.id) continue;
    if (typeof o.title !== "string") continue;
    const starredAt = typeof o.starredAt === "number" && Number.isFinite(o.starredAt) ? o.starredAt : 0;
    out.push({ id: o.id, title: o.title, starredAt });
  }
  return out;
}
/** Return the active org id used by client caches (best-effort; assumes `window` exists). */
function getActiveOrgIdUnsafe(): string | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    const s = typeof raw === "string" ? raw.trim() : "";
    return /^[a-f0-9]{24}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

function storageKeyForActiveOrgUnsafe(): string | null {
  const orgId = getActiveOrgIdUnsafe();
  if (!orgId) return null;
  return `${STORAGE_KEY_BASE}:${orgId}`;
}

/** Read starred docs from localStorage (assumes `window` exists). */
function readStarredDocsUnsafe(): StarredDoc[] {
  const key = storageKeyForActiveOrgUnsafe();
  // If we don't know the active org yet, don't read any cache (prevents stale cross-org flash).
  if (!key) return [];
  const raw = window.localStorage.getItem(key);
  if (!raw) return [];
  return normalizeStarredDocs(safeParseJson(raw));
}
/** Write starred docs to localStorage and emit a change event (assumes `window` exists). */
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
 * Get starred docs.
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
 * Toggle Starred Doc (uses readStarredDocsUnsafe, some, filter).
 */


export function toggleStarredDoc(doc: { id: string; title: string }): { starred: boolean; docs: StarredDoc[] } {
  if (typeof window === "undefined") return { starred: false, docs: [] };
  try {
    const prev = readStarredDocsUnsafe();
    const exists = prev.some((d) => d.id === doc.id);
    const next = exists
      ? prev.filter((d) => d.id !== doc.id)
      : [{ id: doc.id, title: doc.title || "Document", starredAt: Date.now() }, ...prev];
    writeStarredDocsUnsafe(next);
    return { starred: !exists, docs: next };
  } catch {
    return { starred: false, docs: [] };
  }
}
/**
 * Upsert Starred Doc Title (uses readStarredDocsUnsafe, findIndex, slice).
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
 * Move Starred Doc (uses trim, getStarredDocs, readStarredDocsUnsafe).
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
    writeStarredDocsUnsafe(next);
    return { docs: next, moved: true };
  } catch {
    return { docs: getStarredDocs(), moved: false };
  }
}
