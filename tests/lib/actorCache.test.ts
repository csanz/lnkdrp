import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/**
 * Regression tests for the per-request actor cache.
 *
 * Bug: `resolveActorForStats()` stored its own pending promise in the request-keyed cache and
 * then, on its fallback paths, called `resolveActor()` which read that same promise back from
 * the cache and awaited it, so the request hung forever.
 *
 * All DB access is mocked; no MongoDB is needed.
 */

const {
  TEST_ORG_ID,
  TEST_TEMP_ID,
  connectMongo,
  createTempUser,
  verifyTempUserSecret,
  ensurePersonalOrgForUserId,
  userFindOne,
  orgFindOne,
  membershipExists,
  getToken,
} = vi.hoisted(() => {
  // `vi.mock` factories are hoisted above imports, so everything they reference must be hoisted
  // too (and cannot use imported modules such as mongoose, hence fixed ObjectId hex literals).
  const TEST_ORG_ID = "64b0c0ffee0000000000a001";
  const TEST_TEMP_ID = "64b0c0ffee0000000000b002";
  return {
    TEST_ORG_ID,
    TEST_TEMP_ID,
    connectMongo: vi.fn(async () => undefined),
    createTempUser: vi.fn(async () => ({ id: TEST_TEMP_ID, secret: "s3cret" })),
    verifyTempUserSecret: vi.fn(() => false),
    ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: TEST_ORG_ID })),
    userFindOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    orgFindOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    membershipExists: vi.fn(async () => null),
    getToken: vi.fn(async (): Promise<unknown> => null),
  };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findOne: userFindOne },
  createTempUser,
  verifyTempUserSecret,
}));
vi.mock("@/lib/models/Org", () => ({
  OrgModel: { findOne: orgFindOne },
  ensurePersonalOrgForUserId,
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { exists: membershipExists },
}));
vi.mock("next-auth/jwt", () => ({ getToken }));

import { resolveActor, resolveActorForStats, resolveExistingActor } from "@/lib/gating/actor";

const HANG_TIMEOUT_MS = 2_000;

/** Resolve `p`, or reject if it takes longer than `HANG_TIMEOUT_MS` (i.e. the resolver hung). */
async function withinTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`resolver did not settle within ${HANG_TIMEOUT_MS}ms`)), HANG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function enableAuthEnv() {
  process.env.MONGODB_URI = "mongodb://test";
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
}

beforeEach(() => {
  vi.clearAllMocks();
  getToken.mockResolvedValue(null);
  delete process.env.MONGODB_URI;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.API_TEST_BYPASS_AUTH;
  delete process.env.API_TEST_USER_ID;
});

describe("gating/actor.resolveActorForStats", () => {
  test("anonymous bare Request (no session) resolves instead of hanging", async () => {
    const request = new Request("http://localhost/api/dashboard/stats");

    const actor = await withinTimeout(resolveActorForStats(request));

    expect(actor.kind).toBe("temp");
    if (actor.kind === "temp") {
      expect(actor.isNew).toBe(true);
      expect(actor.temp.id).toBe(TEST_TEMP_ID);
    }
    expect(createTempUser).toHaveBeenCalledTimes(1);
  });

  test("signed-in user whose JWT lacks activeOrgId resolves via the full user path", async () => {
    enableAuthEnv();
    const userId = new Types.ObjectId().toHexString();
    getToken.mockResolvedValue({ sub: userId });
    const request = new Request("http://localhost/api/billing/status");

    const actor = await withinTimeout(resolveActorForStats(request));

    expect(actor.kind).toBe("user");
    expect(actor.userId).toBe(userId);
    expect(actor.orgId).toBe(String(TEST_ORG_ID));
    expect(createTempUser).not.toHaveBeenCalled();
  });

  test("shares one cached resolution per Request with resolveActor()", async () => {
    const request = new Request("http://localhost/api/credits/snapshot");

    const a = await withinTimeout(resolveActorForStats(request));
    const b = await withinTimeout(resolveActor(request));

    expect(b).toBe(a);
    expect(createTempUser).toHaveBeenCalledTimes(1);
  });
});

describe("gating/actor.resolveExistingActor", () => {
  test("returns null for an anonymous request without minting a temp user", async () => {
    const request = new Request("http://localhost/api/metrics/events", { method: "POST" });

    const actor = await withinTimeout(resolveExistingActor(request));

    expect(actor).toBeNull();
    expect(createTempUser).not.toHaveBeenCalled();
    expect(ensurePersonalOrgForUserId).not.toHaveBeenCalled();
  });

  test("returns null when temp-user headers point at an unknown/invalid temp user", async () => {
    const request = new Request("http://localhost/api/metrics/events", {
      method: "POST",
      headers: { "x-temp-user-id": TEST_TEMP_ID, "x-temp-user-secret": "nope" },
    });

    const actor = await withinTimeout(resolveExistingActor(request));

    expect(actor).toBeNull();
    expect(userFindOne).toHaveBeenCalledTimes(1);
    expect(createTempUser).not.toHaveBeenCalled();
  });

  test("returns the existing temp actor when the temp-user headers verify", async () => {
    userFindOne.mockReturnValueOnce({
      select: () => ({ lean: async () => ({ _id: new Types.ObjectId(TEST_TEMP_ID), tempSecretHash: "hash" }) as never }),
    });
    verifyTempUserSecret.mockReturnValueOnce(true);
    const request = new Request("http://localhost/api/metrics/events", {
      method: "POST",
      headers: { "x-temp-user-id": TEST_TEMP_ID, "x-temp-user-secret": "s3cret" },
    });

    const actor = await withinTimeout(resolveExistingActor(request));

    expect(actor?.kind).toBe("temp");
    expect(actor?.userId).toBe(TEST_TEMP_ID);
    if (actor?.kind === "temp") expect(actor.isNew).toBe(false);
    expect(createTempUser).not.toHaveBeenCalled();
  });
});
