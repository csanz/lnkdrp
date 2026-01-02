/**
 * Client-side org list cache (memory + localStorage) used to make the workspace switcher instant.
 *
 * Notes:
 * - This is best-effort only; it must never be the source of truth for auth/tenancy.
 * - The server remains the source of truth for active org selection (httpOnly cookie + session claim).
 */
import { fetchJson } from "@/lib/http/fetchJson";

export type OrgsCacheOrg = { id: string; name: string; type: string; role: string; avatarUrl?: string | null };

export type OrgsCacheSnapshot = {
  version: 1;
  userKey: string | null;
  updatedAtMs: number;
  activeOrgId: string | null;
  orgs: OrgsCacheOrg[];
};

/** localStorage key for the orgs cache snapshot. */
export const ORGS_CACHE_STORAGE_KEY = "lnkdrp.orgsCache.v1";

/** Window event name fired whenever the orgs cache snapshot is updated. */
export const ORGS_CACHE_UPDATED_EVENT = "lnkdrp.orgsCache.updated";

let memorySnapshot: OrgsCacheSnapshot | null = null;
let inflightRefresh: Promise<OrgsCacheSnapshot | null> | null = null;

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function coerceSnapshot(v: unknown): OrgsCacheSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<OrgsCacheSnapshot>;
  if (o.version !== 1) return null;
  const orgs = Array.isArray(o.orgs) ? o.orgs : [];
  const cleanedOrgs: OrgsCacheOrg[] = [];
  for (const it of orgs) {
    if (!it || typeof it !== "object") continue;
    const x = it as Partial<OrgsCacheOrg>;
    if (typeof x.id !== "string" || !x.id) continue;
    cleanedOrgs.push({
      id: x.id,
      name: typeof x.name === "string" ? x.name : "",
      type: typeof x.type === "string" ? x.type : "",
      role: typeof x.role === "string" ? x.role : "",
      avatarUrl: typeof (x as { avatarUrl?: unknown }).avatarUrl === "string" ? String((x as { avatarUrl?: string }).avatarUrl) : null,
    });
  }
  return {
    version: 1,
    userKey: typeof o.userKey === "string" ? o.userKey : null,
    updatedAtMs: typeof o.updatedAtMs === "number" ? o.updatedAtMs : 0,
    activeOrgId: typeof o.activeOrgId === "string" ? o.activeOrgId : null,
    orgs: cleanedOrgs,
  };
}

function dispatchUpdatedEvent() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(ORGS_CACHE_UPDATED_EVENT));
  } catch {
    // ignore
  }
}

/**
 * Read the current orgs cache snapshot (prefers in-memory, falls back to localStorage).
 * When `userKey` is provided, snapshots for other users are ignored.
 */
export function readOrgsCacheSnapshot(userKey?: string): OrgsCacheSnapshot | null {
  if (typeof window === "undefined") return null;
  if (memorySnapshot && (!userKey || memorySnapshot.userKey === userKey)) return memorySnapshot;
  try {
    const raw = window.localStorage.getItem(ORGS_CACHE_STORAGE_KEY);
    const parsed = coerceSnapshot(safeParseJson(raw ?? ""));
    if (!parsed) return null;
    if (userKey && parsed.userKey !== userKey) return null;
    memorySnapshot = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write the orgs cache snapshot to memory + localStorage and notify listeners.
 */
export function writeOrgsCacheSnapshot(next: OrgsCacheSnapshot) {
  if (typeof window === "undefined") return;
  memorySnapshot = next;
  try {
    window.localStorage.setItem(ORGS_CACHE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore (quota / private mode)
  }
  dispatchUpdatedEvent();
}

/**
 * Refresh the orgs cache by calling `/api/orgs`.
 *
 * - `force`: bypasses the TTL and always requests the server (still dedupes concurrent refreshes).
 * - `maxAgeMs`: if cache is fresher than this, returns it without requesting the server (unless force).
 */
export async function refreshOrgsCache({
  userKey,
  force = false,
  maxAgeMs = 60_000,
}: {
  userKey?: string;
  force?: boolean;
  maxAgeMs?: number;
} = {}): Promise<OrgsCacheSnapshot | null> {
  if (typeof window === "undefined") return null;

  const cached = readOrgsCacheSnapshot(userKey);
  if (!force && cached && cached.updatedAtMs && Date.now() - cached.updatedAtMs < maxAgeMs) return cached;

  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    try {
      const json = await fetchJson<{
        activeOrgId?: string;
        orgs?: Array<{ id: string; name: string; type: string; role: string; avatarUrl?: string | null }>;
      }>("/api/orgs", { cache: "no-store" });

      const next: OrgsCacheSnapshot = {
        version: 1,
        userKey: typeof userKey === "string" ? userKey : null,
        updatedAtMs: Date.now(),
        activeOrgId: typeof json.activeOrgId === "string" ? json.activeOrgId : null,
        orgs: Array.isArray(json.orgs) ? (json.orgs as OrgsCacheOrg[]) : [],
      };

      writeOrgsCacheSnapshot(next);
      return next;
    } catch {
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

/**
 * Best-effort update of cached active org id (used to avoid UI lag before redirect).
 */
export function setCachedActiveOrgId(nextActiveOrgId: string | null, userKey?: string) {
  if (typeof window === "undefined") return;
  const cur = readOrgsCacheSnapshot(userKey);
  if (!cur) return;
  writeOrgsCacheSnapshot({ ...cur, activeOrgId: nextActiveOrgId, updatedAtMs: Date.now() });
}


