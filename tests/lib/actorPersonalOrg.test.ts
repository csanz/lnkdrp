/**
 * The fast resolvers must not invent `personalOrgId`.
 *
 * Bug: `tryResolveUserActorFast` and `resolveActorForStats` both returned `personalOrgId: orgId`,
 * described in a comment as keeping the field "stable without extra DB work". It was not stable,
 * it was wrong: the codebase asks "is this the person's own workspace" as
 * `actor.orgId === actor.personalOrgId` in dozens of routes — to widen a query to legacy org-less
 * rows, and in `/api/plan` and `/api/agent/status` to decide whether a workspace is personal — so
 * copying the active org into the field made the answer `true` in *every* workspace. The visible
 * symptom was the Billing tab telling a team workspace "Your personal workspace is billed on its
 * own"; the quieter one was team queries widening to the caller's own pre-workspace documents.
 *
 * What is pinned here is the shape of the answer, not the wording of any UI: in a team workspace
 * the two ids differ, in the person's own workspace they match, and the correction costs one
 * cached read rather than the full resolver's upsert.
 *
 * All DB access is mocked, in the style of tests/lib/membershipRevocation.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { PERSONAL_ORG_ID, TEAM_ORG_ID, USER_ID, OTHER_USER_ID, connectMongo, userFindOne, orgFindOne, membershipExists, getToken, ensurePersonalOrgForUserId } =
  vi.hoisted(() => {
    // `vi.mock` factories hoist above imports, so these are fixed hex literals rather than
    // `new Types.ObjectId()`.
    const PERSONAL_ORG_ID = "64b0c0ffee0000000000d001";
    const TEAM_ORG_ID = "64b0c0ffee0000000000d002";
    const USER_ID = "64b0c0ffee0000000000d003";
    const OTHER_USER_ID = "64b0c0ffee0000000000d004";
    return {
      PERSONAL_ORG_ID,
      TEAM_ORG_ID,
      USER_ID,
      OTHER_USER_ID,
      connectMongo: vi.fn(async () => undefined),
      userFindOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
      // The personal-org lookup: `_id`-projected, indexed on `personalForUserId`.
      orgFindOne: vi.fn(() => ({ select: () => ({ lean: async () => ({ _id: PERSONAL_ORG_ID }) }) })),
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
  OrgModel: { findOne: orgFindOne },
  ensurePersonalOrgForUserId,
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { exists: membershipExists },
}));
vi.mock("next-auth/jwt", () => ({ getToken }));

import { membershipChanged, resolveActorForStats, tryResolveUserActorFast } from "@/lib/gating/actor";

/** A signed-in request carrying the team workspace in its active-org cookie. */
function requestInTeamWorkspace(): Request {
  return new Request("http://localhost/api/plan", {
    headers: { cookie: `ld_active_org=${TEAM_ORG_ID}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONGODB_URI = "mongodb://test";
  process.env.NEXTAUTH_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  getToken.mockResolvedValue({ sub: USER_ID, activeOrgId: TEAM_ORG_ID });
  // A live membership in the team workspace: the ordinary case, and the one that used to be wrong.
  membershipExists.mockResolvedValue({ _id: "m1" });
  membershipChanged({ orgId: TEAM_ORG_ID, userId: USER_ID });
});

describe("tryResolveUserActorFast", () => {
  test("a team workspace is not the caller's personal one", async () => {
    const actor = await tryResolveUserActorFast(requestInTeamWorkspace());

    expect(actor?.orgId).toBe(TEAM_ORG_ID);
    expect(actor?.personalOrgId).toBe(PERSONAL_ORG_ID);
    // The expression every caller writes, which used to be `true` here.
    expect(actor?.orgId === actor?.personalOrgId).toBe(false);
  });

  test("the person's own workspace still answers yes", async () => {
    getToken.mockResolvedValue({ sub: USER_ID, activeOrgId: PERSONAL_ORG_ID });
    const request = new Request("http://localhost/api/plan", {
      headers: { cookie: `ld_active_org=${PERSONAL_ORG_ID}` },
    });

    const actor = await tryResolveUserActorFast(request);

    expect(actor?.orgId).toBe(PERSONAL_ORG_ID);
    expect(actor?.orgId === actor?.personalOrgId).toBe(true);
  });

  test("resolving it does not mint a personal org the way the full resolver does", async () => {
    await tryResolveUserActorFast(requestInTeamWorkspace());

    // `ensurePersonalOrgForUserId` is a read plus an upsert; the cheap read answered, so the
    // shortcut this path exists for survives the fix.
    expect(ensurePersonalOrgForUserId).not.toHaveBeenCalled();
  });
});

describe("resolveActorForStats", () => {
  test("/api/plan's `isPersonalOrg` expression is false in a team workspace", async () => {
    const actor = await resolveActorForStats(requestInTeamWorkspace());

    expect(actor.kind).toBe("user");
    expect(actor.orgId).toBe(TEAM_ORG_ID);
    expect(actor.personalOrgId).toBe(PERSONAL_ORG_ID);
  });

  test("the personal-org read is cached, not repeated per request", async () => {
    // A user nothing else in this file has resolved, so the five-minute personal-org cache is cold
    // for them and the first request has to pay for the lookup.
    getToken.mockResolvedValue({ sub: OTHER_USER_ID, activeOrgId: TEAM_ORG_ID });

    await resolveActorForStats(requestInTeamWorkspace());
    expect(orgFindOne.mock.calls.length).toBe(1);

    // A fresh Request, so the per-request actor cache cannot be what answers this one.
    await resolveActorForStats(requestInTeamWorkspace());

    expect(orgFindOne.mock.calls.length).toBe(1);
  });
});
