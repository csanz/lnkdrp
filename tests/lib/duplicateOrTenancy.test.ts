/**
 * One typo, three routes, and it is invisible in review.
 *
 * A Mongo filter is a JavaScript object literal, so a key written twice keeps only the last one.
 * These routes all spread a tenancy clause that is a `$or` and then declare a second `$or` beside
 * it for something unrelated — and the second one silently deletes the first. The query that runs
 * has *fewer* bounds than the code reads as having, and a query with fewer bounds returns more
 * rows, confidently.
 *
 * Where it landed:
 *
 * - **`GET /api/requests`** did it on an `updateMany`. Worse, that handler needs no session at all:
 *   `resolveActor` mints a temp user when nothing authenticates, and a temp actor's active org *is*
 *   its own personal org, so `allowLegacyByUserId` was unconditionally true for a stranger — which
 *   is exactly the branch where the clobbered filter had no workspace bound left. An anonymous GET
 *   ran a write across every tenant's projects.
 * - **`POST /api/requests/:id/guide`** did it on the project lookup, and separately had no role
 *   gate at all, so a `viewer` — the read-only seat handed to outside reviewers — could repoint the
 *   context the AI review agent reads for every future upload into a repo.
 *
 * The fix in both places is the same and is not "be careful": put the two clauses under `$and`, or
 * better, call the shared match helper, so there is no second key to lose.
 *
 * The third test here is the other half of the same class — two places that each wrote out the
 * order of workspace candidates and disagreed about it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const DOC = new Types.ObjectId();

const projectUpdateMany = vi.fn(async (..._a: unknown[]) => ({ modifiedCount: 0 }));
const projectUpdateOne = vi.fn(async (..._a: unknown[]) => ({ modifiedCount: 1 }));
const projectFindOneFilters: unknown[] = [];
const docUpdateOne = vi.fn(async (..._a: unknown[]) => ({ modifiedCount: 1 }));
const resolveActor = vi.fn();
const forbidUnlessOrgRole = vi.fn(async () => null as Response | null);

function chain(value: unknown) {
  return { select: () => ({ lean: async () => value }), lean: async () => value, sort: () => chain(value) };
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gating/actor")>();
  return {
    ...actual,
    resolveActor: (...a: unknown[]) => (resolveActor as never as (...x: unknown[]) => unknown)(...a),
    tryResolveUserActorFastWithPersonalOrg: vi.fn(async () => null),
    applyTempUserHeaders: (res: unknown) => res,
  };
});
vi.mock("@/lib/orgs/requireOrgEditor", () => ({
  forbidUnlessOrgRole: (...a: unknown[]) => (forbidUnlessOrgRole as never as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    updateMany: (...a: unknown[]) => projectUpdateMany(...a),
    updateOne: (...a: unknown[]) => projectUpdateOne(...a),
    findOne: (filter: unknown) => {
      projectFindOneFilters.push(filter);
      return chain({ _id: PROJECT, isRequest: true, requestUploadToken: "t", requestReviewGuideDocId: null });
    },
    find: () => chain([]),
    countDocuments: async () => 0,
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    updateOne: (...a: unknown[]) => docUpdateOne(...a),
    findOne: () => chain({ _id: DOC, orgId: ORG }),
  },
}));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));

import { activeOrgCandidateOrder } from "@/lib/gating/actor";

const signedIn = { kind: "user", userId: ME.toString(), orgId: ORG.toString(), personalOrgId: ORG.toString() };
const stranger = { kind: "temp", userId: ME.toString(), orgId: ORG.toString(), personalOrgId: ORG.toString(), temp: { id: "t" }, isNew: true };

beforeEach(() => {
  vi.clearAllMocks();
  projectFindOneFilters.length = 0;
  resolveActor.mockResolvedValue(signedIn as never);
  forbidUnlessOrgRole.mockResolvedValue(null as never);
});

describe("GET /api/requests: the isRequest backfill", () => {
  test("an unauthenticated caller does not run a migration write", async () => {
    resolveActor.mockResolvedValue(stranger as never);
    const { GET } = await import("@/app/api/requests/route");

    await GET(new Request("http://localhost/api/requests"));

    // The filter's workspace bound was being deleted before the query ran, and this is the actor
    // for whom nothing else stood in its place.
    expect(projectUpdateMany).not.toHaveBeenCalled();
  });

  test("for a signed-in member the workspace bound survives into the query", async () => {
    const { GET } = await import("@/app/api/requests/route");

    await GET(new Request("http://localhost/api/requests"));

    expect(projectUpdateMany).toHaveBeenCalledTimes(1);
    const filter = projectUpdateMany.mock.calls[0]?.[0] as Record<string, unknown>;
    // Exactly one top-level `$or` — the tenancy one — with the isRequest clause parked under `$and`
    // where it cannot replace anything.
    expect(JSON.stringify(filter)).toContain(ORG.toString());
    expect(filter).toHaveProperty("$and");
    expect(JSON.stringify((filter as { $and?: unknown }).$and)).toContain("isRequest");
  });
});

describe("POST /api/requests/:id/guide", () => {
  test("a viewer is refused before anything is written", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    forbidUnlessOrgRole.mockResolvedValue(denied as never);
    const { POST } = await import("@/app/api/requests/[token]/guide/route");

    const res = await POST(
      new Request("http://localhost/api/requests/x/guide", { method: "POST", body: JSON.stringify({ docId: DOC.toString() }) }),
      { params: Promise.resolve({ token: PROJECT.toString() }) },
    );

    expect(res.status).toBe(403);
    expect(projectUpdateOne).not.toHaveBeenCalled();
    expect(docUpdateOne).not.toHaveBeenCalled();
  });

  test("the project lookup keeps its workspace bound", async () => {
    const { POST } = await import("@/app/api/requests/[token]/guide/route");

    await POST(
      new Request("http://localhost/api/requests/x/guide", { method: "POST", body: JSON.stringify({ docId: DOC.toString() }) }),
      { params: Promise.resolve({ token: PROJECT.toString() }) },
    );

    expect(projectFindOneFilters.length).toBeGreaterThan(0);
    const filter = projectFindOneFilters[0] as Record<string, unknown>;
    // Both clauses live under one `$and`, so neither is a top-level key that can overwrite the
    // other. Before, the isRequest `$or` replaced the tenancy `$or` outright.
    expect(filter).toHaveProperty("$and");
    expect(JSON.stringify(filter)).toContain(ORG.toString());
    expect(JSON.stringify(filter)).toContain("isDeleted");
  });
});

describe("activeOrgCandidateOrder", () => {
  const COOKIE = new Types.ObjectId().toString();
  const SAVED = new Types.ObjectId().toString();
  const CLAIM = new Types.ObjectId().toString();

  test("cookie, then the saved workspace, then the token", () => {
    expect(activeOrgCandidateOrder({ cookieOrgId: COOKIE, metadataOrgId: SAVED, claimOrgId: CLAIM })).toEqual([
      COOKIE,
      SAVED,
      CLAIM,
    ]);
  });

  test("with no cookie the saved workspace beats the token", () => {
    // The switcher (`GET /api/orgs`) used to rank these the other way round. A JWT is issued at
    // sign-in and lives for weeks, so on a new device it named a stale workspace while the resolver
    // — and therefore `POST /api/docs` — used the saved one, and the document was created, shared
    // and linked somewhere the person was not looking.
    expect(activeOrgCandidateOrder({ cookieOrgId: "", metadataOrgId: SAVED, claimOrgId: CLAIM })).toEqual([SAVED, CLAIM]);
  });

  test("nonsense is dropped rather than carried to the database", () => {
    expect(activeOrgCandidateOrder({ cookieOrgId: "not-an-id", metadataOrgId: null, claimOrgId: undefined })).toEqual([]);
  });

  test("whitespace does not make a candidate", () => {
    expect(activeOrgCandidateOrder({ cookieOrgId: "   ", metadataOrgId: ` ${SAVED} `, claimOrgId: "" })).toEqual([SAVED]);
  });
});
