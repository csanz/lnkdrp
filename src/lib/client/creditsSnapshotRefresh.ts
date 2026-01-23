/**
 * Client-side helper for refreshing the global credits snapshot (dashboard header + drawer).
 *
 * The dashboard shell listens for this event and re-fetches `/api/credits/snapshot`.
 */
export const CREDITS_SNAPSHOT_REFRESH_EVENT = "lnkdrp:credits-snapshot-refresh";

/**
 * Requests a re-fetch of the global credits snapshot (client-only).
 *
 * Side effects: emits `CREDITS_SNAPSHOT_REFRESH_EVENT` on `window` for listeners (e.g. header).
 */
export function dispatchCreditsSnapshotRefresh() {
  window.dispatchEvent(new Event(CREDITS_SNAPSHOT_REFRESH_EVENT));
}


