/**
 * Session caps (mcp/src/sessionCaps.ts, code review 2026-09-23 M17): one credential cannot hold
 * the server's memory hostage by re-initialising in a loop, and one credential cannot push every
 * other agent off by filling the global cap.
 */
import { describe, expect, it } from "vitest";

import { admitSession, DEFAULT_SESSION_CAPS, sessionCapsFromEnv, type SessionSummary } from "../../mcp/src/sessionCaps";

const s = (id: string, credentialId: string, lastSeenAt: number): SessionSummary => ({ id, credentialId, lastSeenAt });

describe("admitSession", () => {
  it("admits with nothing to evict under both caps", () => {
    expect(admitSession([s("a", "k1", 1)], "k1", { perCredential: 3, total: 10 })).toEqual({ admit: true, evict: [] });
  });

  it("evicts the credential's stalest session at its cap, and only its own", () => {
    const live = [s("old", "k1", 1), s("mid", "k1", 5), s("new", "k1", 9), s("other", "k2", 0)];
    expect(admitSession(live, "k1", { perCredential: 3, total: 10 })).toEqual({ admit: true, evict: ["old"] });
  });

  it("evicts as many as it takes when a cap was lowered under the live count", () => {
    const live = [s("a", "k1", 1), s("b", "k1", 2), s("c", "k1", 3), s("d", "k1", 4)];
    expect(admitSession(live, "k1", { perCredential: 2, total: 10 })).toEqual({ admit: true, evict: ["a", "b", "c"] });
  });

  it("refuses at the total cap instead of evicting somebody else", () => {
    const live = [s("a", "k1", 1), s("b", "k2", 2), s("c", "k3", 3)];
    expect(admitSession(live, "k4", { perCredential: 5, total: 3 })).toEqual({ admit: false, evict: [], reason: "total_cap" });
  });

  it("counts its own eviction against the total, so a full server still admits a reconnect", () => {
    const live = [s("a", "k1", 1), s("b", "k2", 2), s("c", "k3", 3)];
    expect(admitSession(live, "k1", { perCredential: 1, total: 3 })).toEqual({ admit: true, evict: ["a"] });
  });
});

describe("sessionCapsFromEnv", () => {
  it("defaults, and ignores junk or zero rather than treating it as no cap", () => {
    expect(sessionCapsFromEnv({} as unknown as NodeJS.ProcessEnv)).toEqual(DEFAULT_SESSION_CAPS);
    expect(sessionCapsFromEnv({ LNKDRP_MCP_MAX_SESSIONS_PER_KEY: "0", LNKDRP_MCP_MAX_SESSIONS: "lots" } as unknown as NodeJS.ProcessEnv)).toEqual(DEFAULT_SESSION_CAPS);
  });

  it("reads both numbers", () => {
    expect(sessionCapsFromEnv({ LNKDRP_MCP_MAX_SESSIONS_PER_KEY: "3", LNKDRP_MCP_MAX_SESSIONS: "40" } as unknown as NodeJS.ProcessEnv)).toEqual({ perCredential: 3, total: 40 });
  });
});
