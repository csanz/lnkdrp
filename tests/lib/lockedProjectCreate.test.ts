/**
 * `POST /api/projects { locked: true }` seats the creator
 * (docs/prds/lnkdrp-locked-projects.md, M1's one new write).
 *
 * There is no owner bypass anywhere in this feature (decision 21), so a locked room with no members
 * is not a room with a caretaker: it is a room nobody in the workspace can open, and the only way
 * back into one is break-glass, which does not exist until M6. The grant is therefore part of the
 * create, not a follow-up call, and a create that cannot write it must not leave the room behind.
 *
 * The default is pinned in the same file, because M1 is a behaviour-neutral refactor: a request that
 * says nothing about locking must write exactly what it wrote yesterday, and must not touch the
 * grant collection at all.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

/** A mongoose-ish query chain: `select` returns the chain, `lean` resolves the row. */
function chain<T>(result: T) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.lean = async () => result;
  return c;
}

const resolveActor = vi.fn();
const projectCreate = vi.fn(async (_doc: Record<string, unknown>) => ({ _id: PROJECT }) as unknown);
const projectDeleteOne = vi.fn(async (_filter: Record<string, unknown>) => ({ deletedCount: 1 }));
const grantCreate = vi.fn(async (_doc: Record<string, unknown>) => ({ _id: new Types.ObjectId() }) as unknown);
const projectMembershipChanged = vi.fn();
const recordActivity = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => resolveActor(...a),
  applyTempUserHeaders: (res: unknown) => res,
  tryResolveUserActorFastWithPersonalOrg: vi.fn(async () => null),
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    create: (d: Record<string, unknown>) => projectCreate(d),
    deleteOne: (f: Record<string, unknown>) => ({ catch: async () => projectDeleteOne(f) }),
    exists: vi.fn(async () => null),
    find: () => chain([]),
    findOne: () => chain(null),
    countDocuments: vi.fn(async () => 0),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  },
}));
vi.mock("@/lib/models/ProjectMembership", () => ({
  ProjectMembershipModel: { db: { readyState: 1 }, create: (d: Record<string, unknown>) => grantCreate(d) },
}));
vi.mock("@/lib/projects/lockScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/lockScope")>()),
  projectMembershipChanged: (...a: unknown[]) => projectMembershipChanged(...a),
}));
vi.mock("@/lib/crypto/randomBase62", () => ({ newShareId: () => "SHAREIDAAAAA", newSecretToken: () => "s".repeat(24) }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));
vi.mock("@/lib/gating/waitlist", () => ({ forbidWaitlisted: vi.fn(async () => null) }));
vi.mock("@/lib/billing/planLimits", () => ({
  checkLimit: vi.fn(async () => ({ ok: true })),
  planLimitResponse: vi.fn(() => NextResponse.json({ error: "plan" }, { status: 402 })),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity: (...a: unknown[]) => recordActivity(...a) }));
vi.mock("@/lib/http/errorResponse", () => ({
  authOrRateLimitResponse: () => null,
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }),
}));

const { POST } = await import("@/app/api/projects/route");

const actor = { kind: "user", userId: ME.toString(), orgId: ORG.toString(), personalOrgId: new Types.ObjectId().toString() };

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("https://app.lnkdrp.com/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveActor.mockResolvedValue(actor);
  projectCreate.mockImplementation(async () => ({ _id: PROJECT }));
  grantCreate.mockImplementation(async () => ({ _id: new Types.ObjectId() }));
});

describe("the default is untouched", () => {
  test("a create that says nothing about locking writes no visibility and no grant", async () => {
    const res = await post({ name: "Press kit" });
    expect(res.status).toBe(201);

    const doc = projectCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(doc).not.toHaveProperty("visibility");
    expect(doc).not.toHaveProperty("lockedAt");
    expect(doc).not.toHaveProperty("lockedByUserId");
    // The schema default supplies `visibility: "workspace"`, which is what every row written before
    // this feature reads as anyway. What matters is that the route says nothing.
    expect(grantCreate).not.toHaveBeenCalled();
    expect(projectMembershipChanged).not.toHaveBeenCalled();
  });

  test("`locked: false` is the same as saying nothing", async () => {
    await post({ name: "Press kit", locked: false });
    const doc = projectCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(doc).not.toHaveProperty("visibility");
    expect(grantCreate).not.toHaveBeenCalled();
  });

  test("a truthy value that is not `true` does not lock a room by accident", async () => {
    await post({ name: "Press kit", locked: "yes" });
    const doc = projectCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(doc).not.toHaveProperty("visibility");
    expect(grantCreate).not.toHaveBeenCalled();
  });
});

describe("locked: true", () => {
  test("stamps the lock and records who locked it and when", async () => {
    const res = await post({ name: "Acme raise", locked: true });
    expect(res.status).toBe(201);

    const doc = projectCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(doc.visibility).toBe("locked");
    expect(doc.lockedAt).toBeInstanceOf(Date);
    expect(doc.lockedByUserId).toEqual(ME);
  });

  test("seats the creator as the first member, as an editor, via creator", async () => {
    await post({ name: "Acme raise", locked: true });

    expect(grantCreate).toHaveBeenCalledTimes(1);
    expect(grantCreate.mock.calls[0]?.[0]).toMatchObject({
      orgId: ORG,
      projectId: PROJECT,
      userId: ME,
      role: "editor",
      via: "creator",
      addedByUserId: ME,
    });
  });

  test("drops the cached grant set, or the creator's own list hides the room they just made", async () => {
    await post({ name: "Acme raise", locked: true });
    // The ten-second cache would otherwise serve the empty answer it read seconds ago.
    expect(projectMembershipChanged).toHaveBeenCalledWith({ orgId: ORG, userId: ME });
  });

  test("a grant that cannot be written takes the room with it", async () => {
    grantCreate.mockImplementation(async () => {
      throw new Error("grant write failed");
    });
    const res = await post({ name: "Acme raise", locked: true });

    // Not 201: a locked room with no members cannot be opened by anybody, owner included, and
    // break-glass does not exist yet. The project is seconds old and holds nothing, so it goes.
    expect(res.status).toBe(500);
    expect(projectDeleteOne).toHaveBeenCalledWith({ _id: PROJECT });
    expect(projectMembershipChanged).not.toHaveBeenCalled();
  });
});
