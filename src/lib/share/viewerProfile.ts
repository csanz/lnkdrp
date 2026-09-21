/**
 * The name and address a recipient volunteers, as their browser remembers it.
 *
 * Scoped to the workspace that shared the link, deliberately. It used to be one origin-wide key:
 * a recipient who introduced themselves on one sender's deck had their name and email attached to
 * the very first stats POST of *every other* sender's link they opened afterwards — before they
 * had been asked, and directly against what the dialog promises ("Goes to this document's owner
 * only"). Someone who told a supplier who they are had that handed to an unrelated stranger whose
 * link happened to arrive next.
 *
 * So: what may be *sent* lives under a per-workspace key, and reuse only happens inside the
 * workspace the recipient actually answered — the same sender's deck and their data room, which is
 * the point of the feature. A different sender starts from nothing until Save is pressed there.
 *
 * `readShareViewerProfilePrefill` is the other half: the last identity this browser saved, kept so
 * a new sender's form can open with the fields already filled in. It is for *typing convenience
 * only* and must never reach the network on its own — nothing may be sent for a workspace until
 * the recipient presses Save on that workspace's link.
 *
 * This lives here rather than inside the viewer because it is asked in two places — the document
 * viewer and the data room's front page — and the one thing those two must agree on is the
 * identity, not the markup. The normalizers are part of that contract: what the client stores has
 * to be what the server stores, or a recipient's name changes shape depending on which page they
 * typed it into (see `propagateViewerIdentity`, which writes a corrected one through).
 */

/** Per-workspace (or, failing that, per-link) profiles: what this browser may send, and to whom. */
const SHARE_VIEWER_PROFILE_PREFIX = "lnkdrp_share_viewer_profile_v2:";

/**
 * The last identity saved anywhere, used to pre-fill a form and for nothing else.
 *
 * Kept separate from the scoped keys above so that "we can save you some typing" can never turn
 * back into "we told a sender who you are without asking".
 */
export const SHARE_VIEWER_PROFILE_PREFILL_KEY = "lnkdrp_share_viewer_prefill_v1";

/**
 * The old origin-wide key. Read once, downgraded to a pre-fill, then deleted: it is the value that
 * was being replayed to every sender, so leaving it readable as a sendable profile would keep the
 * bug alive for every browser that already has one.
 */
export const LEGACY_SHARE_VIEWER_PROFILE_KEY = "lnkdrp_share_viewer_profile_v1";

export type ShareViewerProfile = {
  name?: string;
  email?: string;
  updatedAt?: number;
};

/**
 * Who this profile belongs to.
 *
 * `ownerKey` is an opaque, stable id for the workspace that shared the link, carried down with the
 * sender's brand. Until a page supplies one, `shareId` keeps the profile on a single link — which
 * asks a recipient twice across one sender's links, but never hands their identity to a sender
 * they have not answered. There is deliberately no third fallback: a scope with neither is a scope
 * with no storage at all, because the global key is exactly what went wrong.
 */
export type ShareViewerScope = { ownerKey?: string | null; shareId?: string | null };

/** The storage key for a scope, or null when the scope identifies nobody. */
export function shareViewerProfileKey(scope: ShareViewerScope): string | null {
  const ownerKey = typeof scope.ownerKey === "string" ? scope.ownerKey.trim() : "";
  if (ownerKey) return `${SHARE_VIEWER_PROFILE_PREFIX}w:${encodeURIComponent(ownerKey)}`;
  const shareId = typeof scope.shareId === "string" ? scope.shareId.trim() : "";
  if (shareId) return `${SHARE_VIEWER_PROFILE_PREFIX}s:${encodeURIComponent(shareId)}`;
  return null;
}

/**
 * The workspace id out of a share's brand payload, when the server sends one.
 *
 * Written defensively because the brand type does not carry it yet (see the note in the viewer):
 * the client half of the per-workspace scope ships now and starts using the key the day the
 * payload gains it, with no second change here.
 */
export function shareBrandOwnerKey(brand: unknown): string | null {
  if (!brand || typeof brand !== "object") return null;
  const raw = (brand as { ownerKey?: unknown }).ownerKey;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/** Collapse whitespace, trim, cap at 80 — the same rule `normalizeViewerName` applies server-side. */
export function normalizeShareViewerName(v: string): string | null {
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > 80 ? s.slice(0, 80) : s;
}

/**
 * Lowercase, trimmed, and plausibly an address.
 *
 * Deliberately not a full RFC check: this is a recipient telling a sender who they are, not an
 * account being created, and rejecting an unusual but real address would cost more than accepting
 * an odd one.
 */
export function normalizeShareViewerEmail(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (s.length > 254) return null;
  if (!s.includes("@") || s.startsWith("@") || s.endsWith("@")) return null;
  return s;
}

/** Parse a stored blob, dropping anything that does not survive the normalizers. */
function parseProfile(raw: string | null): ShareViewerProfile | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { name?: unknown; email?: unknown; updatedAt?: unknown };
    const name = typeof p.name === "string" ? normalizeShareViewerName(p.name) : null;
    const email = typeof p.email === "string" ? normalizeShareViewerEmail(p.email) : null;
    const updatedAt = typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? Math.floor(p.updatedAt) : undefined;
    if (!name && !email) return null;
    return { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(updatedAt ? { updatedAt } : {}) };
  } catch {
    return null;
  }
}

/** The stored shape, stamped with the moment it was saved. */
function serializeProfile(name: string | null, email: string | null): string {
  return JSON.stringify({
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    updatedAt: Date.now(),
  } satisfies ShareViewerProfile);
}

/**
 * Move a pre-fix global profile into the pre-fill slot and delete it.
 *
 * Deliberately not migrated into the scope of whichever link is open: nobody knows which sender
 * that value was typed for, so granting it to the first link opened after the upgrade would be the
 * original bug with one extra step. Recipients press Save once more; senders they never answered
 * get nothing.
 */
function retireLegacyGlobalProfile(): void {
  try {
    const legacy = window.localStorage.getItem(LEGACY_SHARE_VIEWER_PROFILE_KEY);
    if (legacy === null) return;
    window.localStorage.removeItem(LEGACY_SHARE_VIEWER_PROFILE_KEY);
    if (!window.localStorage.getItem(SHARE_VIEWER_PROFILE_PREFILL_KEY)) {
      const parsed = parseProfile(legacy);
      if (parsed) {
        window.localStorage.setItem(
          SHARE_VIEWER_PROFILE_PREFILL_KEY,
          serializeProfile(parsed.name ?? null, parsed.email ?? null),
        );
      }
    }
  } catch {
    // ignore (best-effort)
  }
}

/**
 * The profile this scope's owner has been told, or null.
 *
 * This is the only value that may ride along on a request. A null here means "this sender has not
 * been introduced to", whatever else the browser remembers.
 */
export function readShareViewerProfile(scope: ShareViewerScope): ShareViewerProfile | null {
  if (typeof window === "undefined") return null;
  const key = shareViewerProfileKey(scope);
  if (!key) return null;
  try {
    retireLegacyGlobalProfile();
    return parseProfile(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

/**
 * The last identity saved on any link — for pre-filling a form, never for sending.
 *
 * Callers must keep it out of every payload: it is a convenience for the recipient's fingers, and
 * it becomes a promise only when they press Save.
 */
export function readShareViewerProfilePrefill(): ShareViewerProfile | null {
  if (typeof window === "undefined") return null;
  try {
    retireLegacyGlobalProfile();
    return parseProfile(window.localStorage.getItem(SHARE_VIEWER_PROFILE_PREFILL_KEY));
  } catch {
    return null;
  }
}

/**
 * Store a profile for this scope (and as the next form's pre-fill), or clear it when both fields
 * come back empty.
 */
export function writeShareViewerProfile(
  scope: ShareViewerScope,
  next: { name: string | null; email: string | null },
): void {
  if (typeof window === "undefined") return;
  const key = shareViewerProfileKey(scope);
  if (!key) return;
  try {
    const name = typeof next.name === "string" ? normalizeShareViewerName(next.name) : null;
    const email = typeof next.email === "string" ? normalizeShareViewerEmail(next.email) : null;
    if (!name && !email) {
      clearShareViewerProfile(scope);
      return;
    }
    const serialized = serializeProfile(name, email);
    window.localStorage.setItem(key, serialized);
    window.localStorage.setItem(SHARE_VIEWER_PROFILE_PREFILL_KEY, serialized);
  } catch {
    // ignore (best-effort)
  }
}

/**
 * Forget this sender's copy, and the pre-fill with it.
 *
 * "Clear" is a recipient asking to go back to anonymous. Leaving the pre-fill behind would put
 * their name back in the form the next time they opened it, which is not what the button says.
 */
export function clearShareViewerProfile(scope: ShareViewerScope): void {
  if (typeof window === "undefined") return;
  try {
    const key = shareViewerProfileKey(scope);
    if (key) window.localStorage.removeItem(key);
    window.localStorage.removeItem(SHARE_VIEWER_PROFILE_PREFILL_KEY);
    window.localStorage.removeItem(LEGACY_SHARE_VIEWER_PROFILE_KEY);
  } catch {
    // ignore
  }
}
