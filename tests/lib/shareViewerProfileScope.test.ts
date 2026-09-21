/**
 * The volunteered viewer identity is scoped to the sender.
 *
 * Regression cover for the bug this file exists because of: one origin-wide localStorage key meant
 * a name and email typed for one sender were attached to the first stats POST of every other
 * sender's link the same browser opened. These tests assert the storage contract that stops it —
 * what may be *sent* is per workspace (per link while the workspace key is still being plumbed
 * through), and the only thing that crosses senders is a pre-fill that no caller may send.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_SHARE_VIEWER_PROFILE_KEY,
  SHARE_VIEWER_PROFILE_PREFILL_KEY,
  clearShareViewerProfile,
  readShareViewerProfile,
  readShareViewerProfilePrefill,
  shareBrandOwnerKey,
  shareViewerProfileKey,
  writeShareViewerProfile,
} from "@/lib/share/viewerProfile";

/** The narrow slice of `window` the module touches. */
function installFakeStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return store;
}

describe("share viewer profile scoping", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installFakeStorage();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("keeps one sender's identity away from another sender's link", () => {
    writeShareViewerProfile(
      { ownerKey: "ws_a", shareId: "link_a" },
      { name: "Michael Chen", email: "Michael@Example.com" },
    );

    expect(readShareViewerProfile({ ownerKey: "ws_a", shareId: "link_a" })).toMatchObject({
      name: "Michael Chen",
      email: "michael@example.com",
    });
    // Same workspace, a different link of theirs: recognised, which is the point of the feature.
    expect(readShareViewerProfile({ ownerKey: "ws_a", shareId: "link_a2" })?.email).toBe("michael@example.com");
    // A different sender entirely: nothing to send until they are introduced to.
    expect(readShareViewerProfile({ ownerKey: "ws_b", shareId: "link_b" })).toBeNull();
  });

  it("falls back to the link, never to a shared key, when no workspace id is available", () => {
    writeShareViewerProfile({ ownerKey: null, shareId: "link_a" }, { name: null, email: "a@example.com" });

    expect(readShareViewerProfile({ ownerKey: null, shareId: "link_a" })?.email).toBe("a@example.com");
    expect(readShareViewerProfile({ ownerKey: null, shareId: "link_b" })).toBeNull();
    // A scope identifying nobody stores nothing at all.
    expect(shareViewerProfileKey({ ownerKey: null, shareId: null })).toBeNull();
    writeShareViewerProfile({ ownerKey: null, shareId: null }, { name: "Nobody", email: "n@example.com" });
    expect(readShareViewerProfile({ ownerKey: null, shareId: null })).toBeNull();
  });

  it("pre-fills across senders without making the identity sendable there", () => {
    writeShareViewerProfile({ ownerKey: "ws_a", shareId: "link_a" }, { name: "Michael", email: "m@example.com" });

    // The form on a new sender's link may open filled in...
    expect(readShareViewerProfilePrefill()?.email).toBe("m@example.com");
    // ...but until Save is pressed there, that sender's scope is empty and nothing rides along.
    expect(readShareViewerProfile({ ownerKey: "ws_b", shareId: "link_b" })).toBeNull();
  });

  it("retires the old origin-wide key instead of granting it to the next link opened", () => {
    store.set(LEGACY_SHARE_VIEWER_PROFILE_KEY, JSON.stringify({ name: "Michael", email: "m@example.com" }));

    // Whichever link this browser opens next, the legacy value is not its profile.
    expect(readShareViewerProfile({ ownerKey: "ws_b", shareId: "link_b" })).toBeNull();
    expect(store.has(LEGACY_SHARE_VIEWER_PROFILE_KEY)).toBe(false);
    // It survives only as typing convenience.
    expect(readShareViewerProfilePrefill()?.email).toBe("m@example.com");
  });

  it("clear forgets this sender's copy and the pre-fill with it", () => {
    writeShareViewerProfile({ ownerKey: "ws_a", shareId: "link_a" }, { name: "Michael", email: "m@example.com" });
    clearShareViewerProfile({ ownerKey: "ws_a", shareId: "link_a" });

    expect(readShareViewerProfile({ ownerKey: "ws_a", shareId: "link_a" })).toBeNull();
    expect(readShareViewerProfilePrefill()).toBeNull();
    expect(store.has(SHARE_VIEWER_PROFILE_PREFILL_KEY)).toBe(false);
  });

  it("reads a workspace id off the brand payload only when the server actually sends one", () => {
    expect(shareBrandOwnerKey(null)).toBeNull();
    expect(shareBrandOwnerKey({ name: "USAVX", avatarUrl: null })).toBeNull();
    expect(shareBrandOwnerKey({ name: "USAVX", avatarUrl: null, ownerKey: " ws_a " })).toBe("ws_a");
  });
});
