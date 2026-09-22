/**
 * Creating a workspace is identity work, so an `lnk_` key may not do it.
 *
 * `POST /api/orgs` was the one handler on the workspace surface the key split missed. PATCH and
 * DELETE on `/api/orgs/:orgId` refuse a key; the handler that *makes* the workspace did not, and
 * because `resolveActor` returns `kind: "user"` for a key bearer, the route's `kind` check read
 * like an auth gate while letting the key straight through to `OrgModel.create({ type: "team" })`.
 *
 * What is pinned here is the refusal and its blast radius: nothing is written, and the account's
 * Free `team_workspaces` slot is not spent. The second test is the control — a real session still
 * gets past the guard and is stopped only by the body validator — so a guard that refused everyone
 * would not pass this file either.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const USER = new Types.ObjectId().toString();
const ORG = new Types.ObjectId().toString();

const connectMongo = vi.fn(async () => undefined);
const orgCreate = vi.fn();
const orgExists = vi.fn(async () => null);
const membershipCreate = vi.fn();
const membershipFind = vi.fn();
const resolveActor = vi.fn();
const tryResolveAuthUserId = vi.fn(async () => null);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/Org", () => ({
  OrgModel: { create: orgCreate, exists: orgExists, find: vi.fn(), findOne: vi.fn() },
  ensurePersonalOrgForUserId: vi.fn(),
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { create: membershipCreate, find: membershipFind },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { findOne: vi.fn() } }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor,
  tryResolveAuthUserId,
  activeOrgCandidateOrder: () => [],
}));

const { POST } = await import("@/app/api/orgs/route");

function createRequest(body: unknown) {
  return new Request("http://localhost/api/orgs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgExists.mockResolvedValue(null);
});

describe("POST /api/orgs and API keys", () => {
  test("an lnk_ key cannot create a workspace", async () => {
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: USER,
      orgId: ORG,
      personalOrgId: ORG,
      viaApiKey: { keyId: "key_1", scopes: ["docs:write"] },
    });

    const res = await POST(createRequest({ name: "Agent's own workspace" }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("api_key_forbidden");
    // Named, not just "forbidden": an agent told which action is closed can tell its human.
    expect(json.message).toContain("create a workspace");
  });

  test("the refusal happens before anything is written or any allowance is spent", async () => {
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: USER,
      orgId: ORG,
      personalOrgId: ORG,
      viaApiKey: { keyId: "key_1", scopes: ["docs:write"] },
    });

    await POST(createRequest({ name: "Agent's own workspace" }));

    expect(orgCreate).not.toHaveBeenCalled();
    expect(membershipCreate).not.toHaveBeenCalled();
    // The plan-limit read counts the owner's team workspaces; not reaching it is what keeps the
    // Free slot unspent.
    expect(membershipFind).not.toHaveBeenCalled();
    expect(connectMongo).not.toHaveBeenCalled();
  });

  test("a signed-in person is not refused by the key guard", async () => {
    resolveActor.mockResolvedValue({ kind: "user", userId: USER, orgId: ORG, personalOrgId: ORG });

    // No name, so the body validator answers first: proof the guard let a session actor past
    // without the test needing the database behind the plan limit.
    const res = await POST(createRequest({}));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Org name is required");
  });

  test("a temp visitor is still 401, not 403", async () => {
    resolveActor.mockResolvedValue({ kind: "temp", orgId: ORG, temp: { id: "t1" } });

    const res = await POST(createRequest({ name: "Nope" }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("AUTH_REQUIRED");
  });
});
