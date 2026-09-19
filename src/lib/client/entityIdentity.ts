/**
 * Who a document or a project is — the one cheap read that answers "what is this called", shared
 * by everything in a header band.
 *
 * Three things on a sub-page need that same fact at the same moment: the identity row's name, the
 * breadcrumb that points back at the resource, and whatever copy names it. Each of them used to
 * either fetch it again or wait on something far slower — a project's metrics header waited on the
 * whole analytics aggregation, which is why walking into Metrics showed the word "Project" for a
 * second and then renamed itself. Keyed by kind and id here, with concurrent callers sharing one
 * request, the name arrives in one hop and every part of the band gets it together.
 *
 * `settled` is the other half, and the reason this is not just a cache. A skeleton is honest only
 * while an answer is still coming; once the read has failed or come back nameless the caller has to
 * print something, so `settled` is what tells it to stop waiting. A pulse that never resolves is a
 * worse lie than a plain noun.
 *
 * Freshness is unchanged from the per-page fetches this replaces: every mount starts a read (unless
 * one is already in flight), so a rename elsewhere still corrects within one navigation. The cached
 * value only decides what is painted while that read is out.
 */
"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { type EntityKind, rememberEntityTitle } from "@/lib/client/entityTitles";
import { ACTIVE_ORG_CHANGED_EVENT } from "@/lib/sidebarCache";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/** A project pill on a document's identity row. */
export type EntityProjectPill = { id: string; name: string; isRequest?: boolean };

export type EntityIdentity = {
  /** The resource's own name. Empty string means the server has one and it is blank. */
  name: string;
  /** The current version number — documents only; `null` on projects and on an unversioned doc. */
  version: number | null;
  /** The projects a document belongs to — empty on the project scope. */
  projects: EntityProjectPill[];
  /**
   * Whether a project is a request repository — projects only, always false for a document.
   *
   * It is part of the identity because it picks the header's glyph. Without it the sub-page rows
   * defaulted to a folder, so walking from a request project into its Links or Metrics swapped the
   * inbox glyph for a folder and dropped the "Request link" badge: the band changed identity on
   * exactly the navigation this is meant to hold still.
   */
  isRequest: boolean;
};

/** What a caller sees: the identity if it is known, and whether the read has come back at all. */
export type EntityIdentityState = { identity: EntityIdentity | null; settled: boolean };

const NOTHING_YET: EntityIdentityState = { identity: null, settled: false };

const state = new Map<string, EntityIdentityState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** One resource, one entry: the kind disambiguates a document and a project with the same id. */
function cacheKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Snapshots are replaced, never mutated: `useSyncExternalStore` compares by reference, so a caller
 * that re-renders for an unrelated reason must get back the very same object it had.
 */
function publish(key: string, next: EntityIdentityState): void {
  state.set(key, next);
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscription: re-render every header when one identity is learned. */
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

/**
 * A workspace switch drops everything held here, exactly as `entityTitles` drops its names and for
 * the same reason: signing into a second account and opening a link to the first one's document
 * must not paint that document's cached name for the beat before the API refuses it.
 */
function onActiveOrgChanged(): void {
  state.clear();
  inflight.clear();
  /**
   * Clearing alone left every mounted header pulsing forever.
   *
   * `useEntityIdentity`'s effect is keyed on `[kind, id]`, neither of which changes when the
   * workspace does, so nothing re-ran the read: the snapshot fell back to "nothing yet, no read in
   * flight" and the skeleton never resolved — the one thing this module's own contract forbids.
   * Bumping a generation the effect also depends on makes the switch a refetch.
   */
  generation += 1;
  for (const listener of listeners) listener();
}

/** Incremented on every workspace switch, so mounted readers re-run their read. */
let generation = 0;

/** `/api/docs/:id?lite=1` — the document's title, version and projects without its extracted text. */
async function readDoc(id: string): Promise<EntityIdentity | null> {
  const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(id)}?lite=1`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    doc?: { title?: unknown; lastUpdate?: { version?: unknown } | null; projects?: unknown };
  } | null;
  const raw = json?.doc;
  if (!raw) return null;
  const projects = Array.isArray(raw.projects)
    ? (raw.projects as Array<Record<string, unknown>>).map((p) => ({
        id: String(p.id ?? ""),
        name: typeof p.name === "string" ? p.name : "",
        isRequest: Boolean(p.isRequest),
      }))
    : [];
  const version = raw.lastUpdate && typeof raw.lastUpdate.version === "number" ? raw.lastUpdate.version : null;
  // `isRequest` describes a project, never a document; a document's own request-ness is carried by
  // the pills in `projects`.
  return { name: typeof raw.title === "string" ? raw.title.trim() : "", version, projects, isRequest: false };
}

/**
 * `/api/projects/:id` has no GET (only PATCH/DELETE); the project row rides along with its document
 * list, and `limit=1` keeps that read to a single document for what is only a header title.
 */
async function readProject(id: string): Promise<EntityIdentity | null> {
  const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(id)}/docs?limit=1`, { cache: "no-store" });
  if (!res.ok) return null;
  const json = (await res.json()) as { project?: { name?: unknown; isRequest?: unknown } } | null;
  const name = typeof json?.project?.name === "string" ? json.project.name.trim() : "";
  if (!json?.project) return null;
  return { name, version: null, projects: [], isRequest: Boolean(json.project.isRequest) };
}

/**
 * Start (or join) the read for one resource.
 *
 * Everything that mounts in the same band asks at the same instant, so the second and third callers
 * get the first one's promise rather than a second round trip.
 */
export function loadEntityIdentity(kind: EntityKind, id: string): Promise<void> {
  if (typeof window === "undefined" || !id) return Promise.resolve();
  const key = cacheKey(kind, id);
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = (async () => {
    let identity: EntityIdentity | null = null;
    try {
      identity = kind === "doc" ? await readDoc(id) : await readProject(id);
    } catch {
      // A refused, offline or malformed read is still an answer as far as the header is concerned:
      // stop pulsing and let the caller print whatever it has.
    } finally {
      inflight.delete(key);
    }
    if (identity) {
      publish(key, { identity, settled: true });
      // The server has spoken — correct the remembered name for every page after this one.
      if (identity.name) rememberEntityTitle(kind, id, identity.name);
      return;
    }
    publish(key, { identity: state.get(key)?.identity ?? null, settled: true });
  })();
  inflight.set(key, run);
  return run;
}

/**
 * The identity of one resource, kept in sync as it is learned.
 *
 * Reports "nothing yet" on the server and on the first render after a hard page load, which is the
 * signal for a header to show its skeleton — and which keeps the markup React hydrates against
 * identical to the HTML it was sent. After a client-side navigation the read starts on mount and
 * the remembered name (see `entityTitles`) already covers the frames before it lands.
 */
export function useEntityIdentity(kind: EntityKind, id: string | null | undefined): EntityIdentityState {
  const key = id ? cacheKey(kind, id) : "";
  const getSnapshot = useCallback(() => (key ? (state.get(key) ?? NOTHING_YET) : NOTHING_YET), [key]);
  const getServerSnapshot = useCallback(() => NOTHING_YET, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (id) void loadEntityIdentity(kind, id);
    // `generation` is in the deps on purpose: see `onActiveOrgChanged`.
  }, [kind, id, generation]);

  return snapshot;
}

