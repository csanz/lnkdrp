/**
 * `GET`/`POST`/`DELETE /api/projects/:id/members`, and the review token the lock is confirmed with
 * (docs/prds/lnkdrp-locked-projects.md, decisions 23, 24 and 31).
 *
 * These three methods are the only CHECKS in the whole feature: everywhere else a caller who may not
 * see a room is answered 404 with a body byte-identical to a room that never existed, because a 403
 * on a read is a sentence reading "a private room with this name exists". Here the caller has already
 * passed the by-id filter and demonstrably knows the room exists, so the refusals can say what they
 * mean, and the ones worth pinning are the two that are easy to get wrong in the direction of
 * stranding somebody: an API key doing identity work, and removing the last person from a locked
 * room, which leaves a room nobody in the workspace can open.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

/** A mongoose-ish query chain: `select`/`sort`/`limit` return the chain, `lean` resolves the rows. */
function chain<T>(result: T) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.sort = () => c;
  c.limit = () => c;
  c.lean = async () => result;
  return c;
}

const resolveActor = vi.fn();
const resolveProjectForActor = vi.fn();
const projectGrants = vi.fn();
const grantProjectMembership = vi.fn(async () => ({ added: true }));
const revokeProjectGrants = vi.fn(async () => 1);
const recordActivity = vi.fn();
const orgMembershipExists = vi.fn(async (): Promise<{ _id: Types.ObjectId } | null> => ({ _id: new Types.ObjectId() }));
const orgMemberships = vi.fn(() => [
  { userId: ME, role: "member" },
  { userId: OTHER, role: "owner" },
]);

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => resolveActor(...a),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: (...a: unknown[]) => recordActivity(...a) }));
vi.mock("@/lib/http/errorResponse", () => ({
  authOrRateLimitResponse: () => null,
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }),
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: {
    exists: (...a: unknown[]) => orgMembershipExists(...(a as [])),
    find: () => chain(orgMemberships()),
  },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    find: () =>
      chain([
        { _id: ME, name: "Me", email: "me@example.com" },
        { _id: OTHER, name: "Dana", email: "dana@example.com" },
      ]),
    findById: () => chain({ name: "Dana", email: "dana@example.com" }),
  },
}));
vi.mock("@/lib/projects/resolveProject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/resolveProject")>()),
  resolveProjectForActor: (...a: unknown[]) => resolveProjectForActor(...a),
}));
vi.mock("@/lib/projects/lockScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/lockScope")>()),
  projectGrants: (...a: unknown[]) => projectGrants(...a),
  grantProjectMembership: (...a: unknown[]) => grantProjectMembership(...(a as [])),
  revokeProjectGrants: (...a: unknown[]) => revokeProjectGrants(...(a as [])),
}));

const { GET, POST, DELETE } = await import("@/app/api/projects/[projectSlug]/members/route");
const { createLockReviewToken, verifyLockReviewToken, LOCK_REVIEW_TTL_MS } = await import("@/lib/projects/lockReview");

const actor = {
  kind: "user" as const,
  userId: ME.toString(),
  orgId: ORG.toString(),
  personalOrgId: new Types.ObjectId().toString(),
};

const ctx = { params: Promise.resolve({ projectSlug: PROJECT.toString() }) };

function req(method: string, body?: Record<string, unknown>): Request {
  return new Request(`https://app.lnkdrp.com/api/projects/${PROJECT}/members`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function grant(userId: Types.ObjectId, over: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    userId,
    role: "editor",
    via: "added",
    addedByUserId: ME,
    reason: "",
    createdDate: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveActor.mockResolvedValue(actor);
  resolveProjectForActor.mockResolvedValue({ _id: PROJECT, name: "Acme raise", visibility: "locked" });
  projectGrants.mockResolvedValue([grant(ME)]);
  grantProjectMembership.mockResolvedValue({ added: true });
  revokeProjectGrants.mockResolvedValue(1);
  orgMembershipExists.mockResolvedValue({ _id: new Types.ObjectId() });
});

describe("a room a caller cannot see is not there", () => {
  test("every method answers the uniform 404, with no hint that the room exists", async () => {
    resolveProjectForActor.mockResolvedValue(null);
    for (const call of [GET(req("GET"), ctx), POST(req("POST", { userId: String(OTHER), role: "editor" }), ctx), DELETE(req("DELETE", { userId: String(OTHER) }), ctx)]) {
      const res = (await call) as Response;
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });
});

describe("an API key cannot touch the member list", () => {
  test("all three methods refuse a key: membership is identity, and identity is not delegated", async () => {
    resolveActor.mockResolvedValue({ ...actor, viaApiKey: true });
    const responses = await Promise.all([
      GET(req("GET"), ctx) as Promise<Response>,
      POST(req("POST", { userId: String(OTHER), role: "editor" }), ctx) as Promise<Response>,
      DELETE(req("DELETE", { userId: String(OTHER) }), ctx) as Promise<Response>,
    ]);
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("api_key_forbidden");
    }
    // And nothing was written on the way to the refusal.
    expect(grantProjectMembership).not.toHaveBeenCalled();
    expect(revokeProjectGrants).not.toHaveBeenCalled();
  });
});

describe("GET names the room's people and the workspace's", () => {
  test("members carry names and roles, candidates are the people not in the room", async () => {
    const res = (await GET(req("GET"), ctx)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      project: { visibility: string; visibleBecause: string };
      members: Array<{ userId: string; name: string; orgRole: string }>;
      candidates: Array<{ userId: string }>;
      cap: number;
      membersCanManageLinks: boolean;
    };
    expect(json.project.visibility).toBe("locked");
    expect(json.project.visibleBecause).toBe("member");
    expect(json.members).toHaveLength(1);
    expect(json.members[0]).toMatchObject({ userId: String(ME), name: "Me", orgRole: "member" });
    expect(json.candidates.map((c) => c.userId)).toEqual([String(OTHER)]);
    expect(json.cap).toBe(200);
  });

  test("it says when nobody in the room can manage its share links (decision 24)", async () => {
    // The room holds one `member`, and writing a project link takes `admin`. The only people with the
    // role cannot see the room, so the panel has to say so rather than let somebody discover it.
    const res = (await GET(req("GET"), ctx)) as Response;
    expect((await res.json()).membersCanManageLinks).toBe(false);
  });

  test("an owner in the room satisfies it", async () => {
    projectGrants.mockResolvedValue([grant(ME), grant(OTHER)]);
    const res = (await GET(req("GET"), ctx)) as Response;
    expect((await res.json()).membersCanManageLinks).toBe(true);
  });
});

describe("POST adds a workspace member, and only a workspace member", () => {
  test("it writes the grant and a feed row inside the room", async () => {
    const res = (await POST(req("POST", { userId: String(OTHER), role: "reader" }), ctx)) as Response;
    expect(res.status).toBe(200);
    expect(grantProjectMembership).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, userId: String(OTHER), role: "reader", via: "added" }),
    );
    const row = recordActivity.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.type).toBe("project.member_added");
    // Carries `projectId`, so it lives in the room's own feed and not the workspace one.
    expect(row.projectId).toEqual(PROJECT);
    expect(row.meta).toMatchObject({ targetUserId: String(OTHER), role: "reader" });
  });

  test("no role is a 400, because editor is a real power nobody should be handed by omission", async () => {
    const res = (await POST(req("POST", { userId: String(OTHER) }), ctx)) as Response;
    expect(res.status).toBe(400);
    expect(grantProjectMembership).not.toHaveBeenCalled();
  });

  test("somebody who is not in the workspace is refused, and the room is not named in the refusal", async () => {
    orgMembershipExists.mockResolvedValue(null);
    const res = (await POST(req("POST", { userId: String(OTHER), role: "editor" }), ctx)) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a member of this workspace/i);
    expect(grantProjectMembership).not.toHaveBeenCalled();
  });

  test("the two-hundred cap refuses the next person, and says what to do instead", async () => {
    projectGrants.mockResolvedValue(Array.from({ length: 200 }, () => grant(new Types.ObjectId())));
    const res = (await POST(req("POST", { userId: String(OTHER), role: "editor" }), ctx)) as Response;
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe("PROJECT_MEMBER_CAP");
    expect(json.error).toMatch(/200 people/);
    expect(grantProjectMembership).not.toHaveBeenCalled();
  });

  test("somebody already in the room does not trip the cap", async () => {
    const rows = Array.from({ length: 200 }, () => grant(new Types.ObjectId()));
    rows[0] = grant(OTHER);
    projectGrants.mockResolvedValue(rows);
    const res = (await POST(req("POST", { userId: String(OTHER), role: "editor" }), ctx)) as Response;
    expect(res.status).toBe(200);
  });

  test("a grant that already existed writes no second feed row", async () => {
    grantProjectMembership.mockResolvedValue({ added: false });
    await POST(req("POST", { userId: String(OTHER), role: "editor" }), ctx);
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("DELETE never empties a locked room", () => {
  test("the last member is refused with 409 and told what to do", async () => {
    const res = (await DELETE(req("DELETE", { userId: String(ME) }), ctx)) as Response;
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe("LAST_PROJECT_MEMBER");
    expect(json.error).toMatch(/Unlock it or add someone first/);
    expect(revokeProjectGrants).not.toHaveBeenCalled();
  });

  test("the last grant on an UNLOCKED room may go: there is nothing to be locked out of", async () => {
    resolveProjectForActor.mockResolvedValue({ _id: PROJECT, name: "Press kit", visibility: "workspace" });
    const res = (await DELETE(req("DELETE", { userId: String(ME) }), ctx)) as Response;
    expect(res.status).toBe(200);
    expect(revokeProjectGrants).toHaveBeenCalledWith(
      expect.objectContaining({ userId: String(ME), projectIds: [PROJECT] }),
    );
  });

  test("removing one of several clears just that grant, in just this room", async () => {
    projectGrants.mockResolvedValue([grant(ME), grant(OTHER)]);
    const res = (await DELETE(req("DELETE", { userId: String(OTHER) }), ctx)) as Response;
    expect(res.status).toBe(200);
    expect(revokeProjectGrants).toHaveBeenCalledWith(
      expect.objectContaining({ userId: String(OTHER), projectIds: [PROJECT] }),
    );
    const row = recordActivity.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.type).toBe("project.member_removed");
    expect(row.projectId).toEqual(PROJECT);
  });

  test("removing somebody who is already out is a success, not an error", async () => {
    const res = (await DELETE(req("DELETE", { userId: String(new Types.ObjectId()) }), ctx)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: false });
    expect(revokeProjectGrants).not.toHaveBeenCalled();
  });
});

describe("the lock review token", () => {
  const args = { projectId: PROJECT, userId: ME, target: "locked" as const };

  test("a token minted for a room, a person and a direction verifies for exactly that", () => {
    const token = createLockReviewToken(args);
    expect(verifyLockReviewToken(token, args)).toEqual({ ok: true });
  });

  test("it does not confirm the other direction", () => {
    const token = createLockReviewToken(args);
    expect(verifyLockReviewToken(token, { ...args, target: "workspace" })).toEqual({ ok: false, reason: "wrong_room" });
  });

  test("it does not confirm another room, or somebody else's review", () => {
    const token = createLockReviewToken(args);
    expect(verifyLockReviewToken(token, { ...args, projectId: new Types.ObjectId() })).toEqual({
      ok: false,
      reason: "wrong_room",
    });
    expect(verifyLockReviewToken(token, { ...args, userId: OTHER })).toEqual({ ok: false, reason: "wrong_room" });
  });

  test("it expires, so a token left in a closed tab does not confirm a lock tomorrow", () => {
    const now = Date.now();
    const token = createLockReviewToken({ ...args, now });
    expect(verifyLockReviewToken(token, { ...args, now: now + LOCK_REVIEW_TTL_MS + 1 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("a tampered payload fails on the signature rather than being read", () => {
    const token = createLockReviewToken(args);
    const [segment, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, p: "project_lock_review", r: String(PROJECT), u: String(OTHER), t: "locked", e: Date.now() + 1000 }),
      "utf8",
    ).toString("base64url");
    expect(segment).not.toBe(forged);
    expect(verifyLockReviewToken(`${forged}.${sig}`, args)).toEqual({ ok: false, reason: "bad_signature" });
  });

  test("nothing at all is `missing`, which is what the write reports as review required", () => {
    expect(verifyLockReviewToken(undefined, args)).toEqual({ ok: false, reason: "missing" });
  });
});
