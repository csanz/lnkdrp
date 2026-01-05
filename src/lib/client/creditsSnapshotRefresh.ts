/**
 * Client-side helper for refreshing the global credits snapshot (dashboard header + drawer).
 *
 * The dashboard shell listens for this event and re-fetches `/api/credits/snapshot`.
 */
export const CREDITS_SNAPSHOT_REFRESH_EVENT = "lnkdrp:credits-snapshot-refresh";

export function dispatchCreditsSnapshotRefresh() {
  window.dispatchEvent(new Event(CREDITS_SNAPSHOT_REFRESH_EVENT));
}


