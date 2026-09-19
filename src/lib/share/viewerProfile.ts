/**
 * The name and address a recipient volunteers, as their browser remembers it.
 *
 * One key for every share they open, deliberately: someone who introduced themselves on a deck last
 * week should not be asked again when the same sender's data room arrives — the point of the
 * feature is that a recipient answers once and is recognised after that.
 *
 * This lives here rather than inside the viewer because it is now asked in two places — the
 * document viewer and the data room's front page — and the one thing those two must agree on is the
 * identity, not the markup. The normalizers are part of that contract: what the client stores has
 * to be what the server stores, or a recipient's name changes shape depending on which page they
 * typed it into (see `propagateViewerIdentity`, which writes a corrected one through).
 */
export const SHARE_VIEWER_PROFILE_KEY = "lnkdrp_share_viewer_profile_v1";

export type ShareViewerProfile = {
  name?: string;
  email?: string;
  updatedAt?: number;
};

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

/** The stored profile, or null when there is none (or storage is unavailable). */
export function readShareViewerProfile(): ShareViewerProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SHARE_VIEWER_PROFILE_KEY);
    if (!raw) return null;
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

/** Store a profile, or clear it when both fields come back empty. */
export function writeShareViewerProfile(next: { name: string | null; email: string | null }): void {
  if (typeof window === "undefined") return;
  try {
    const name = typeof next.name === "string" ? normalizeShareViewerName(next.name) : null;
    const email = typeof next.email === "string" ? normalizeShareViewerEmail(next.email) : null;
    if (!name && !email) {
      window.localStorage.removeItem(SHARE_VIEWER_PROFILE_KEY);
      return;
    }
    window.localStorage.setItem(
      SHARE_VIEWER_PROFILE_KEY,
      JSON.stringify({ ...(name ? { name } : {}), ...(email ? { email } : {}), updatedAt: Date.now() } satisfies ShareViewerProfile),
    );
  } catch {
    // ignore (best-effort)
  }
}

export function clearShareViewerProfile(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SHARE_VIEWER_PROFILE_KEY);
  } catch {
    // ignore
  }
}
