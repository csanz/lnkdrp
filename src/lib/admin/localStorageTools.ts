/**
 * Admin-only localStorage helpers.
 *
 * These are used by admin tools (e.g. `/a/tools/cache`) and are not intended for the main app UI.
 */

export type LocalStorageRow = {
  key: string;
  value: string;
  bytes: number;
};

/** Return the UTF-8 byte size of a string (best-effort). */
export function byteSizeUtf8(s: string) {
  try {
    return new Blob([s]).size;
  } catch {
    return s.length;
  }
}

/** Read a sorted snapshot of localStorage keys/values (best-effort; returns [] if unavailable). */
export function readLocalStorageSnapshot(): LocalStorageRow[] {
  if (typeof window === "undefined") return [];
  try {
    const rows: LocalStorageRow[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      const value = window.localStorage.getItem(key) ?? "";
      rows.push({ key, value, bytes: byteSizeUtf8(value) });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows;
  } catch {
    return [];
  }
}

/** Remove a single localStorage key; returns true if it no longer exists (best-effort). */
export function removeLocalStorageKey(key: string) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
  try {
    return window.localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

/**
 * Clear localStorage keys for the app based on a prefix and optional extra keys.
 * Returns the keys we attempted to clear (best-effort).
 */
export function clearLocalStorageKeysByPrefix(prefix: string, extraKeys: string[] = []) {
  if (typeof window === "undefined") return [];
  const keysToClear: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(prefix)) keysToClear.push(k);
    }
    for (const k of extraKeys) keysToClear.push(k);
    for (const k of keysToClear) {
      try {
        window.localStorage.removeItem(k);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return keysToClear;
}




