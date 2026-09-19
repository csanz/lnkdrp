/**
 * Removing someone from a workspace has to actually remove them.
 *
 * Two things stood between the Remove button and that being true, and both are pinned here because
 * neither is visible in the route that does the removing:
 *
 * 1. **The JWT claim was taken on trust.** `tryResolveUserActor` built its org from
 *    `session.activeOrgId` and only *overrode* it when the DB copy or the cookie validated. A JWT
 *    is issued at sign-in and lives for weeks, so a removed member kept resolving to the workspace
 *    they had been removed from — on every route using the full resolver — until they next signed
 *    in. The removal was, in effect, a note on the Members page.
 * 2. **The membership cache had no invalidation.** `tryResolveUserActorFast` and friends cache
 *    "is this person a member" for ten seconds, which is fine for a read and wrong for a security
 *    action; `membershipChanged` is what the revoke/leave/claim routes call so the answer is gone
 *    before the page repaints.
 *
 * All DB access is mocked, in the style of tests/lib/actorCache.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { PERSONAL_ORG_ID, TEAM_ORG_ID, USER_ID, connectMongo, userFindOne, membershipExists, getToken, ensurePersonalOrgForUserId } =
  vi.hoisted(() => {
    // `vi.mock` factories hoist above imports, so these are fixed hex literals rather than
    // `new Types.ObjectId()`.
    const PERSONAL_ORG_ID = "64b0c0ffee0000000000a001";
    const TEAM_ORG_ID = "64b0c0ffee0000000000a002";
    const USER_ID = "64b0c0ffee0000000000b001";
    return {
      PERSONAL_ORG_ID,
      TEAM_ORG_ID,
      USER_ID,
      connectMongo: vi.fn(async () => undefined),
      userFindOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
      membershipExists: vi.fn(async (_filter: Record<string, unknown>) => null as unknown),
      getToken: vi.fn(async (): Promise<unknown> => null),
      ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: PERSONAL_ORG_ID })),
    };
  });

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findOne: userFindOne },
  createTempUser: vi.fn(),
  verifyTempUserSecret: vi.fn(() => false),
}));
vi.mock("@/lib/models/Org", () => ({
  OrgModel: { findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })) },
  ensurePersonalOrgForUserId,
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { exists: membershipExists },
}));
vi.mock("next-auth/jwt", () => ({ getToken }));

import { membershipChanged, tryResolveUserActor, tryResolveUserActorFast } from "@/lib/gating/actor";

/** A signed-in request whose JWT claims the team workspace as active. */
function requestWithTeamClaim(): Request {
  return new Request("http://localhost/api/docs");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONGODB_URI = "mongodb://test";
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  getToken.mockResolvedValue({ sub: USER_ID, activeOrgId: TEAM_ORG_ID });
  membershipExists.mockResolvedValue(null);
  // Every test resolves a fresh workspace, so no cached answer leaks between them.
  membershipChanged({ orgId: TEAM_ORG_ID, userId: USER_ID });
});

describe("tryResolveUserActor: the JWT's workspace claim", () => {
  test("a member keeps the workspace their token names", async () => {
    membershipExists.mockResolvedValue({ _id: "m1" });

    const actor = await tryResolveUserActor(requestWithTeamClaim());

    expect(actor?.kind).toBe("user");
    expect(actor?.orgId).toBe(TEAM_ORG_ID);
  });

  test("a removed member falls back to their own workspace, token or no token", async () => {
    // Nobody is a member of anything: the removal has happened, the JWT has not noticed.
    membershipExists.mockResolvedValue(null);

    const actor = await tryResolveUserActor(requestWithTeamClaim());

    expect(actor?.kind).toBe("user");
    // Not TEAM_ORG_ID — that is the whole point. They are signed in, and in their own workspace.
    expect(actor?.orgId).toBe(PERSONAL_ORG_ID);
    expect(actor?.personalOrgId).toBe(PERSONAL_ORG_ID);
  });

  test("the claim is checked against a membership at all", async () => {
    membershipExists.mockResolvedValue(null);

    await tryResolveUserActor(requestWithTeamClaim());

    const asked = membershipExists.mock.calls.map(([f]) => String((f as { orgId?: unknown }).orgId));
    expect(asked).toContain(TEAM_ORG_ID);
  });

  test("a person's own workspace needs no membership round-trip", async () => {
    getToken.mockResolvedValue({ sub: USER_ID, activeOrgId: PERSONAL_ORG_ID });

    const actor = await tryResolveUserActor(requestWithTeamClaim());

    expect(actor?.orgId).toBe(PERSONAL_ORG_ID);
    const asked = membershipExists.mock.calls.map(([f]) => String((f as { orgId?: unknown }).orgId));
    expect(asked).not.toContain(PERSONAL_ORG_ID);
  });

  test("a membership lookup that fails does not lock a real member out", async () => {
    membershipExists.mockRejectedValue(new Error("mongo is having a moment"));

    const actor = await tryResolveUserActor(requestWithTeamClaim());

    // An outage is not a revocation: the claim stands rather than dumping them into a workspace
    // that is not the one they were working in.
    expect(actor?.orgId).toBe(TEAM_ORG_ID);
  });
});

describe("membershipChanged", () => {
  test("a removal takes effect now, not when the ten-second cache expires", async () => {
    membershipExists.mockResolvedValue({ _id: "m1" });
    const first = await tryResolveUserActorFast(requestWithTeamClaim());
    expect(first?.orgId).toBe(TEAM_ORG_ID);

    // Second call inside the TTL: answered from cache, no second round-trip.
    const callsAfterFirst = membershipExists.mock.calls.length;
    await tryResolveUserActorFast(requestWithTeamClaim());
    expect(membershipExists.mock.calls.length).toBe(callsAfterFirst);

    // The revoke route removes the membership and says so.
    membershipExists.mockResolvedValue(null);
    membershipChanged({ orgId: TEAM_ORG_ID, userId: USER_ID });

    expect(await tryResolveUserActorFast(requestWithTeamClaim())).toBeNull();
    expect(membershipExists.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test("clearing an entry that was never cached is not an error", () => {
    expect(() => membershipChanged({ orgId: TEAM_ORG_ID, userId: "64b0c0ffee0000000000b009" })).not.toThrow();
  });
});
