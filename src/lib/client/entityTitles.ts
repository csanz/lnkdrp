/**
 * What this browser last knew a document or a project to be called.
 *
 * The app's resource pages are client-first by design: `/doc/:id` and `/project/:id` render
 * immediately and hydrate from `/api/docs/:id` / `/api/projects/:id` afterwards, which is what
 * makes navigation from the dashboard feel instant. The cost was the title. Until that fetch
 * landed there was nothing true to show, so the header showed a placeholder — the literal word
 * "Document" or "Project", or a pulsing skeleton — and then swapped it for the real name a moment
 * later. Walking between a document and its sub-pages did it again each time, because each page
 * mounts its own fetch. The name of the thing you are looking at is the last thing on the page
 * that should be uncertain.
 *
 * The fix is that the client almost always *already knows* the name: you arrived by clicking a row
 * that displayed it. So every surface that renders a list of documents or projects records what it
 * showed, and every header reads it back and paints the real name on its first frame. The fetch
 * still runs and still wins — it is the authority, this is only a head start.
 *
 * Rules this follows:
 * - **A known name is never replaced by a placeholder.** Once `recall` has answered, a header must
 *   not fall back to "Document" or a skeleton because a refetch is in flight.
 * - **The server always wins.** `remember` is called with every authoritative payload, so a rename
 *   elsewhere corrects this within one fetch.
 * - **Storage is advisory.** Private windows and blocked storage make every read miss, and the
 *   only consequence is the old behaviour: a skeleton for one beat. Every access is wrapped.
 * - **SSR-safe.** `useEntityTitle` reports nothing on the server, so the markup React hydrates
 *   against never disagrees with the HTML. A client-side navigation — the case the user actually
 *   complained about — has no server render at all and gets the name synchronously, first paint.
 */
"use client";

import { useCallback, useSyncExternalStore } from "react";

import { ACTIVE_ORG_CHANGED_EVENT, ACTIVE_ORG_STORAGE_KEY, getSidebarCacheSnapshot } from "@/lib/sidebarCache";
import { getStarredDocs } from "@/lib/starredDocs";

export type EntityKind = "doc" | "project";

/**
 * Bump when the stored shape changes; an old key is simply ignored and re-learned.
 *
 * The `lnkdrp` prefix is not decoration: the admin cache tools count and clear localStorage by
 * that prefix (`src/app/a/tools/cache/page.tsx`), and this is the only one of these caches that
 * holds raw user content, so it must be inside what "Clear app cache" actually clears.
 */
const STORAGE_KEY_BASE = "lnkdrp-entity-titles-v1";

/**
 * Names are keyed per workspace, exactly as `sidebarCache` keys its snapshot, and for the same
 * reason: two workspaces (or two people) sharing a browser must not read each other's document
 * titles out of localStorage. Without this, signing into a second account and opening a link to a
 * document of the first would paint that document's remembered name for the beat before the API
 * refused it.
 */
function storageKey(): string | null {
  const org = activeOrgId();
  // No shared "anon" bucket. `getSidebarCacheSnapshot` and `getStarredDocs` both refuse to answer
  // while the active workspace is unknown, precisely so a name learned in one workspace cannot be
  // painted in another during the window before `/api/orgs/active` resolves. A cache that answered
  // anyway would reintroduce the cross-workspace flash the per-workspace key exists to prevent.
  return org ? `${STORAGE_KEY_BASE}:${org}` : null;
}

/** The workspace these names belong to, read the way the other client caches read it. */
function activeOrgId(): string | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    const trimmed = (raw ?? "").trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * How many names to keep. Titles are short, and a workspace big enough to overflow this is one
 * where the oldest entries are the least likely to be navigated to next. Oldest-first eviction.
 */
const MAX_ENTRIES = 300;

/** In-memory mirror of the store — authoritative during a session; storage is the cold start. */
const memory = new Map<string, string>();

/** The workspace `memory` was loaded for, so a switch drops names that belong to the other one. */
let loadedOrgId: string | null = null;

/** Subscribers to re-render when a name is learned or corrected. */
const listeners = new Set<() => void>();

let loaded = false;

/** The storage key for one entity. */
function key(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/** Pull the persisted map into memory once per page load. Never throws. */
function load(): void {
  const org = activeOrgId();
  // A workspace switch invalidates everything held: reload from that workspace's own key.
  if (loaded && org === loadedOrgId) return;
  if (loaded && org !== loadedOrgId) {
    memory.clear();
  }
  loaded = true;
  loadedOrgId = org;
  try {
    const k = storageKey();
    if (!k) return;
    const raw = window.localStorage.getItem(k);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v) memory.set(k, v);
    }
  } catch {
    // Unparseable, blocked, or absent: we simply know nothing yet.
  }
}

/** Write memory back out, trimmed to the cap. Never throws. */
function persist(): void {
  try {
    const entries = Array.from(memory.entries());
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    if (trimmed.length !== entries.length) {
      memory.clear();
      for (const [k, v] of trimmed) memory.set(k, v);
    }
    const k = storageKey();
    if (!k) return;
    window.localStorage.setItem(k, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Quota, private window, disabled storage: the in-memory map still serves this session.
  }
}

/** Tell every mounted `useEntityTitle` that a name was learned or corrected. */
function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Record what a document or project is called.
 *
 * Safe to call on every render and with every payload — a value equal to what we already hold is
 * dropped without notifying, so this cannot loop a component that renders on change.
 */
export function rememberEntityTitle(kind: EntityKind, id: string, title: string | null | undefined): void {
  if (typeof window === "undefined") return;
  const trimmed = (title ?? "").toString().trim();
  if (!id || !trimmed) return;
  load();
  const k = key(kind, id);
  if (memory.get(k) === trimmed) return;
  // Delete first so re-learning a name also makes it most recent for eviction purposes.
  memory.delete(k);
  memory.set(k, trimmed);
  persist();
  emit();
}

/** Record a whole list at once — what a dashboard, search result page or project grid just drew. */
export function rememberEntityTitles(
  kind: EntityKind,
  rows: ReadonlyArray<{ id?: string | null; title?: string | null; name?: string | null }>,
): void {
  if (typeof window === "undefined" || !rows?.length) return;
  load();
  let changed = false;
  for (const row of rows) {
    const id = (row?.id ?? "").toString();
    const raw = row?.title ?? row?.name ?? "";
    const trimmed = raw.toString().trim();
    if (!id || !trimmed) continue;
    const k = key(kind, id);
    if (memory.get(k) === trimmed) continue;
    memory.delete(k);
    memory.set(k, trimmed);
    changed = true;
  }
  if (!changed) return;
  persist();
  emit();
}

/**
 * The caches the app already keeps that happen to contain names, consulted only on a miss.
 *
 * The sidebar snapshot and the starred list are written long before this module exists in a
 * session — they are what the sidebar draws from on a cold load — so reading them here means a
 * click on a sidebar row paints the right title even on the first navigation after a hard reload,
 * with nothing to seed first. Both are synchronous and both swallow their own storage errors.
 */
function recallFromExistingCaches(kind: EntityKind, id: string): string | null {
  try {
    if (kind === "doc") {
      const starred = getStarredDocs().find((d) => d.id === id);
      if (starred?.title?.trim()) return starred.title.trim();
    }
    const snapshot = getSidebarCacheSnapshot();
    if (!snapshot) return null;
    if (kind === "doc") {
      const hit = snapshot.docs?.items?.find((d) => d.id === id);
      return hit?.title?.trim() || null;
    }
    const hit =
      snapshot.projects?.items?.find((p) => p.id === id) ?? snapshot.requests?.items?.find((p) => p.id === id);
    return hit?.name?.trim() || null;
  } catch {
    return null;
  }
}

/** The last known name, or null. Synchronous, and safe to call during a client render. */
export function recallEntityTitle(kind: EntityKind, id: string): string | null {
  if (typeof window === "undefined" || !id) return null;
  load();
  const own = memory.get(key(kind, id));
  if (own) return own;
  return recallFromExistingCaches(kind, id);
}

/**
 * Drop every remembered name.
 *
 * `memoryOnly` matches `clearSidebarCache`'s option of the same name: on a workspace switch the
 * in-memory map must go but the other workspace's stored names are still theirs to keep, while a
 * deliberate sign-out clears the stored copy too.
 */
export function clearEntityTitles(opts?: { memoryOnly?: boolean }): void {
  if (typeof window === "undefined") return;
  memory.clear();
  loaded = false;
  loadedOrgId = null;
  if (!opts?.memoryOnly) {
    try {
      const k = storageKey();
      if (k) window.localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
  emit();
}

/** Forget one — used when a document or project is deleted, so a stale name cannot resurface. */
export function forgetEntityTitle(kind: EntityKind, id: string): void {
  if (typeof window === "undefined" || !id) return;
  load();
  if (!memory.delete(key(kind, id))) return;
  persist();
  emit();
}

/** `useSyncExternalStore` subscription: re-render this component when a name changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener(ACTIVE_ORG_CHANGED_EVENT, onActiveOrgChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener(ACTIVE_ORG_CHANGED_EVENT, onActiveOrgChanged);
    }
  };
}

/** A workspace switch: forget what was held and re-read under the new workspace's key. */
function onActiveOrgChanged(): void {
  // Same rule as `entityIdentity`: the workspace becoming *known* is not a switch. `load()` already
  // drops the map when the org it was loaded for differs, so all this has to do is prompt a re-read
  // — and only when a known workspace is actually being replaced.
  const next = activeOrgId();
  if (loadedOrgId && loadedOrgId === next) return;
  memory.clear();
  loaded = false;
  loadedOrgId = null;
  emit();
}

/**
 * The last known name of one entity, kept in sync as it is learned or corrected.
 *
 * Returns `null` on the server and on the first render after a hard page load, which is the
 * signal for a header to show its skeleton. After a client-side navigation it returns the real
 * name on the first frame, which is the entire point.
 */
export function useEntityTitle(kind: EntityKind, id: string | null | undefined): string | null {
  const getSnapshot = useCallback(() => (id ? recallEntityTitle(kind, id) : null), [kind, id]);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The name to paint right now: what the server has said this render, else what we remembered,
 * else nothing. `null` means "show the skeleton"; it is never the word "Document" or "Project",
 * because a placeholder that looks like a name is the bug this module exists to remove.
 */
export function resolveEntityTitle(
  kind: EntityKind,
  id: string | null | undefined,
  serverTitle: string | null | undefined,
  remembered: string | null,
): string | null {
  const fromServer = (serverTitle ?? "").toString().trim();
  if (fromServer) return fromServer;
  return remembered || null;
}
