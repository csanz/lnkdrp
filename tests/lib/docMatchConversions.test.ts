/**
 * Four more places that looked one document up by id with their own copy of "which document may
 * this actor act on", now routed through `buildDocMatch` (src/lib/docs/docMatch.ts).
 *
 * None of the four was wrong today. That is the point of pinning them: the hand-rolled copies were
 * term-for-term the shared rule, and a copy that is right today is the copy that drifts tomorrow,
 * because the next fix to the rule (deletion, legacy scope, whatever comes after) lands in the
 * helper and not in the copy. SECURITY.md section 7, pattern 1, is the shape every one of these had:
 * a spread `$or` with a sibling key, one edit away from a second `$or` that silently replaces it.
 *
 * - `resolveDocAnalyticsAccess` (every owner analytics route on one document).
 * - `POST /api/requests/:id/guide`, whose read of the guide document had its own copy while the two
 *   writes three lines below it already used the helper.
 * - `GET /api/projects/:id/docs`, which resolves a request repo's guide document by id for its
 *   title.
 * - `GET /api/changes?docId=`, which used to take the workspace listing filter and bolt an `_id` on.
 *
 * Pinned as filters-issued assertions, the style of tests/lib/crossTenantScoping.test.ts: the rule
 * lives in the query the model receives, not in the response body. The listing half of
 * `/api/changes` is also pinned, so converting the by-id branch cannot have narrowed the list.
 */
import fs from "node:fs";
import path from "node:path";

import { Types } from "mongoose";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { buildDocMatch } from "@/lib/docs/docMatch";

const TEAM_ORG = new Types.ObjectId();
const PERSONAL_ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const DOC = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const REPO_ROOT = path.resolve(__dirname, "../..");

/** A mongoose-ish query chain: every builder method returns the chain, `lean` resolves the rows. */
function chain<T>(result: T) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "sort", "skip", "limit", "populate"]) c[m] = () => c;
  c.lean = async () => result;
  return c;
}

// --- shared module mocks -----------------------------------------------------------------------

const resolveActor = vi.fn();
const docFindOne = vi.fn((_filter: Record<string, unknown>) => chain(null as unknown));
const docFind = vi.fn((_filter: Record<string, unknown>) => chain([] as unknown[]));
const docUpdateOne = vi.fn(async (..._a: unknown[]) => ({ matchedCount: 1, modifiedCount: 1 }));
const docCountDocuments = vi.fn(async (_filter: Record<string, unknown>) => 0);
const projectFindOne = vi.fn((_filter: Record<string, unknown>) => chain(null as unknown));
const projectFind = vi.fn((_filter: Record<string, unknown>) => chain([] as unknown[]));
const projectUpdateOne = vi.fn(async (..._a: unknown[]) => ({ matchedCount: 1, modifiedCount: 1 }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn(), debugEnabled: () => false }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => resolveActor(...a),
  tryResolveUserActorFast: vi.fn(async () => null),
  tryResolveUserActorFastWithPersonalOrg: vi.fn(async () => null),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: (f: Record<string, unknown>) => docFindOne(f),
    find: (f: Record<string, unknown>) => docFind(f),
    updateOne: (...a: unknown[]) => docUpdateOne(...a),
    countDocuments: (f: Record<string, unknown>) => docCountDocuments(f),
  },
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (f: Record<string, unknown>) => projectFindOne(f),
    // The locked-room helper reads the workspace's locked project ids (decision 6). No rows here, so
    // `hiddenProjectIds` answers `[]`, `lockedHomeExclusion` answers `{}`, and the filters these tests
    // compare stay byte-identical to the ones they were written against — which is exactly the
    // no-locked-project guarantee, asserted by construction rather than by assumption.
    find: (f: Record<string, unknown>) => projectFind(f),
    updateOne: (...a: unknown[]) => projectUpdateOne(...a),
  },
}));
vi.mock("@/lib/models/ProjectMembership", () => ({
  ProjectMembershipModel: { find: () => chain([]), db: { readyState: 1 } },
}));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { find: () => chain([]) } }));
vi.mock("@/lib/models/Review", () => ({ ReviewModel: { aggregate: vi.fn(async () => []) } }));
vi.mock("@/lib/models/DocChange", () => ({
  DocChangeModel: { find: () => chain([]), aggregate: vi.fn(async () => []) },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: () => chain([]) } }));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { aggregate: vi.fn(async () => []) } }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/share/projectLinks", () => ({ ensureDefaultProjectLink: vi.fn(async () => null) }));
vi.mock("@/lib/billing/planLimits", () => ({
  getWorkspacePlan: vi.fn(async () => "free"),
  analyticsTierForPlan: vi.fn(() => "basic"),
  limitsForPlan: vi.fn(() => ({ analyticsDays: 30 })),
}));

import { resolveDocAnalyticsAccess } from "@/lib/analytics/docAnalyticsAccess";
import { POST as guidePOST } from "@/app/api/requests/[token]/guide/route";
import { GET as projectDocsGET } from "@/app/api/projects/[projectSlug]/docs/route";
import { GET as changesGET } from "@/app/api/changes/route";

/** Signed in, looking at a team workspace: no legacy by-user alternative may appear. */
const inTeam = { kind: "user", userId: ME.toString(), orgId: TEAM_ORG.toString(), personalOrgId: PERSONAL_ORG.toString() };
/** Signed in, in their own personal workspace: pre-workspace documents of theirs resolve too. */
const inPersonal = { kind: "user", userId: ME.toString(), orgId: PERSONAL_ORG.toString(), personalOrgId: PERSONAL_ORG.toString() };

/** No locked rooms in these fixtures, so the exclusion is `{}` and the match is what it always was. */
const teamMatch = buildDocMatch(DOC, TEAM_ORG, ME, false, {});
const personalMatch = buildDocMatch(DOC, PERSONAL_ORG, ME, true, {});

beforeEach(() => {
  vi.clearAllMocks();
  docFindOne.mockImplementation(() => chain({ _id: DOC, orgId: TEAM_ORG, title: "Guide" }));
  docFind.mockImplementation(() => chain([]));
  projectFindOne.mockImplementation(() =>
    chain({
      _id: PROJECT,
      orgId: TEAM_ORG,
      shareId: "p".repeat(12),
      isRequest: true,
      requestUploadToken: "upload-token",
      requestViewToken: "view-token",
      requestReviewGuideDocId: DOC,
      docCount: 0,
    }),
  );
});

describe("resolveDocAnalyticsAccess", () => {
  test("in a team workspace the lookup is the shared match and nothing else", async () => {
    resolveActor.mockResolvedValue(inTeam);
    const res = await resolveDocAnalyticsAccess(new Request("http://x/api/docs/x/pages"), DOC.toString());
    expect(res.ok).toBe(true);
    expect(docFindOne).toHaveBeenCalledTimes(1);
    expect(docFindOne.mock.calls[0][0]).toEqual(teamMatch);
    expect(JSON.stringify(docFindOne.mock.calls[0][0])).not.toContain("userId");
  });

  test("in the personal workspace the legacy alternative is there, and `isDeleted` binds both", async () => {
    resolveActor.mockResolvedValue(inPersonal);
    await resolveDocAnalyticsAccess(new Request("http://x/api/docs/x/pages"), DOC.toString());
    const filter = docFindOne.mock.calls[0][0];
    expect(filter).toEqual(personalMatch);
    expect(Object.keys(filter).sort()).toEqual(["$or", "isDeleted"]);
  });
});

describe("POST /api/requests/:id/guide", () => {
  const post = (actor: unknown) => {
    resolveActor.mockResolvedValue(actor);
    return guidePOST(
      new Request("http://x/api/requests/x/guide", { method: "POST", body: JSON.stringify({ docId: DOC.toString() }) }),
      { params: Promise.resolve({ token: PROJECT.toString() }) },
    );
  };

  test("the guide document is read with the same match its two writes already used", async () => {
    const res = await post(inTeam);
    expect(res.status).toBe(200);
    expect(docFindOne).toHaveBeenCalledTimes(1);
    expect(docFindOne.mock.calls[0][0]).toEqual(teamMatch);
    // The read and the first write are now literally the same filter.
    expect(docUpdateOne.mock.calls[0][0]).toEqual(docFindOne.mock.calls[0][0]);
  });

  test("from the personal workspace the read carries the legacy scope, once", async () => {
    await post(inPersonal);
    expect(docFindOne.mock.calls[0][0]).toEqual(personalMatch);
  });

  test("a document outside the match is a 404, before any write", async () => {
    docFindOne.mockImplementation(() => chain(null));
    const res = await post(inTeam);
    expect(res.status).toBe(404);
    expect(docUpdateOne).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/:id/docs guide title", () => {
  const get = (actor: unknown) => {
    resolveActor.mockResolvedValue(actor);
    return projectDocsGET(new Request("http://x/api/projects/x/docs"), {
      params: Promise.resolve({ projectSlug: PROJECT.toString() }),
    });
  };

  test("a request repo's guide document is resolved by the shared match", async () => {
    const res = await get(inTeam);
    expect(res.status).toBe(200);
    expect(docFindOne).toHaveBeenCalledTimes(1);
    expect(docFindOne.mock.calls[0][0]).toEqual(teamMatch);
    const body = (await res.json()) as { project?: { request?: { guideDocId?: string | null; guideDocTitle?: string | null } } };
    expect(body.project?.request?.guideDocId).toBe(DOC.toString());
    expect(body.project?.request?.guideDocTitle).toBe("Guide");
  });

  test("and with the legacy scope from the personal workspace", async () => {
    await get(inPersonal);
    expect(docFindOne.mock.calls[0][0]).toEqual(personalMatch);
  });

  test("a guide that no longer matches is simply not titled", async () => {
    docFindOne.mockImplementation(() => chain(null));
    const res = await get(inTeam);
    const body = (await res.json()) as { project?: { request?: { guideDocTitle?: string | null } } };
    expect(body.project?.request?.guideDocTitle).toBeNull();
  });
});

describe("GET /api/changes", () => {
  const get = (actor: unknown, query: string) => {
    resolveActor.mockResolvedValue(actor);
    return changesGET(new Request(`http://x/api/changes${query}`));
  };

  test("`?docId=` is the shared by-id match plus the listing's visibility rule", async () => {
    docFind.mockImplementation(() => chain([{ _id: DOC, title: "Deck", shareId: "abc" }]));
    const res = await get(inTeam, `?docId=${DOC.toString()}`);
    expect(res.status).toBe(200);
    expect(docFind).toHaveBeenCalledTimes(1);
    expect(docFind.mock.calls[0][0]).toEqual({ ...teamMatch, visibility: { $ne: "project" } });
  });

  test("`?docId=` from the personal workspace keeps exactly one `$or`", async () => {
    docFind.mockImplementation(() => chain([{ _id: DOC, title: "Deck", shareId: "abc" }]));
    await get(inPersonal, `?docId=${DOC.toString()}`);
    const filter = docFind.mock.calls[0][0];
    expect(filter).toEqual({ ...personalMatch, visibility: { $ne: "project" } });
    expect(Object.keys(filter).sort()).toEqual(["$or", "isDeleted", "visibility"]);
  });

  test("a document the match refuses is a 404, not an empty history", async () => {
    docFind.mockImplementation(() => chain([]));
    const res = await get(inTeam, `?docId=${DOC.toString()}`);
    expect(res.status).toBe(404);
  });

  test("the listing is untouched: workspace, deletion and visibility bounds, no `_id`", async () => {
    await get(inPersonal, "");
    const filter = docFind.mock.calls[0][0] as Record<string, unknown>;
    expect(filter._id).toBeUndefined();
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.visibility).toEqual({ $ne: "project" });
    expect(filter.$or).toEqual([
      { orgId: PERSONAL_ORG },
      { userId: ME, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
    ]);

    docFind.mockClear();
    await get(inTeam, "");
    expect(docFind.mock.calls[0][0]).toEqual({ orgId: TEAM_ORG, isDeleted: { $ne: true }, visibility: { $ne: "project" } });
  });
});

/** The four files, so a copy pasted back in fails here rather than in production. */
const CONVERTED = [
  "src/lib/analytics/docAnalyticsAccess.ts",
  "src/app/api/requests/[token]/guide/route.ts",
  "src/app/api/projects/[projectSlug]/docs/route.ts",
  "src/app/api/changes/route.ts",
];

describe("the by-id document lookups call the shared match", () => {
  test.each(CONVERTED)("%s imports buildDocMatch and does not hand-roll a by-id document match", (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    expect(source).toMatch(/import \{ buildDocMatch \} from "@\/lib\/docs\/docMatch"/);
    // The shape every copy had: a `DocModel.findOne({` whose first key is `_id:` followed by the
    // inline `allowLegacyByUserId ? ... : ...` spread. The listings in these files start with the
    // spread, not with `_id`, so they are not caught by this.
    expect(source).not.toMatch(/DocModel\.findOne\(\{\s*\n?\s*_id:/);
    expect(source).not.toMatch(/\{ _id: docObjectId, orgId, isDeleted/);
  });
});
