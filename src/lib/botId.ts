/**
 * Bot / device identifier helpers (client-only).
 *
 * This is a lightweight, privacy-preserving identifier stored in localStorage.
 * It helps us rate-limit and reduce abuse on public request upload links without requiring sign-in.
 */

export const BOT_ID_STORAGE_KEY = "lnkdrp_botid_v1";
export const BOT_ID_HEADER = "x-lnkdrp-botid";
/** Return whether we have access to `window` and `localStorage`. */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}
/** Generate a new bot id (prefers `crypto.randomUUID()` when available). */
function makeBotId(): string {
  return typeof crypto !== "undefined" &&
    "randomUUID" in crypto &&
    typeof (crypto as unknown as { randomUUID?: unknown }).randomUUID === "function"
    ? (crypto as unknown as { randomUUID: () => string }).randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Returns a stable per-browser identifier, creating one if needed.
 *
 * - Returns null on server or if localStorage is unavailable.
 */
export function getOrCreateBotId(): string | null {
  if (typeof window === "undefined") return null;

  // 1) Prefer persisted localStorage id.
  if (isBrowser()) {
    try {
      const existing = window.localStorage.getItem(BOT_ID_STORAGE_KEY);
      if (existing && existing.trim()) return existing.trim();
      const created = makeBotId();
      window.localStorage.setItem(BOT_ID_STORAGE_KEY, created);
      return created;
    } catch {
      // fall through
    }
  }

  // 2) Fallback: in-memory id (covers environments where localStorage is blocked).
  try {
    const w = window as unknown as { __lnkdrpBotId?: unknown };
    if (typeof w.__lnkdrpBotId === "string" && w.__lnkdrpBotId.trim()) return w.__lnkdrpBotId.trim();
    const created = makeBotId();
    w.__lnkdrpBotId = created;
    return created;
  } catch {
    return null;
  }
}


