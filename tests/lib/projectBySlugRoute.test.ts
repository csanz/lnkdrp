/**
 * `GET /api/projects/:idOrSlug` is the by-slug lookup the MCP server uses instead of paging
 * through the whole project list to find one slug.
 *
 * Pinned as filters-issued assertions, the style of tests/lib/crossTenantScoping.test.ts: the
 * tenancy rule lives in the query the model receives. Three things must hold:
 *
 * 1. A slug resolves through `liveProjectBySlugMatch` with the caller's workspace bound on it, and
 *    without the legacy by-user alternative when the caller is in a team workspace.
 * 2. An unknown slug is a plain 404, and only when the workspace still has live projects with no
 *    stored slug does the 404 say `reason: "slug_backfill_pending"`. That word is what the MCP keys
 *    its list-scan fallback on, so a 404 that always carried it would put the scan back on every
 *    miss, and one that never carried it would strand a pre-slug project.
 * 3. The body is the same DTO `GET /api/projects` lists, so a client can treat both reads alike.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

import { liveProjectByIdMatch, liveProjectBySlugMatch, slugBackfillPendingFilter } from "@/lib/projects/scope";

const TEAM_ORG = new Types.ObjectId();
const PERSONAL_ORG = new Types.ObjectId();
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
const projectFindOne = vi.fn((_filter: Record<string, unknown>) => chain(null as unknown));
const projectExists = vi.fn(async (_filter: Record<string, unknown>) => null as unknown);

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => resolveActor(...a),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (f: Record<string, unknown>) => projectFindOne(f),
    exists: (f: Record<string, unknown>) => projectExists(f),
    updateOne: vi.fn(async () => ({ matchedCount: 0 })),
    create: vi.fn(),
    deleteOne: vi.fn(),
  },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { find: () => chain([]), updateMany: vi.fn(), updateOne: vi.fn() } }));
vi.mock("@/lib/crypto/randomBase62", () => ({ newSecretToken: (n = 24) => "s".repeat(n), newShareId: () => "SHAREIDAAAAA" }));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/http/errorResponse", () => ({
  authOrRateLimitResponse: () => null,
  errorJson: (err: unknown) => NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 }),
}));
vi.mock("@/lib/share/projectLinks", () => ({ setAllProjectLinksEnabled: vi.fn(), syncProjectShareState: vi.fn() }));
vi.mock("@/lib/tags/service", () => ({ removeAllTagsFromTarget: vi.fn(async () => undefined) }));

const { GET } = await import("@/app/api/projects/[projectSlug]/route");

const inTeam = { kind: "user", userId: ME.toString(), orgId: TEAM_ORG.toString(), personalOrgId: PERSONAL_ORG.toString() };
const inPersonal = { kind: "user", userId: ME.toString(), orgId: PERSONAL_ORG.toString(), personalOrgId: PERSONAL_ORG.toString() };

const stored = {
  _id: PROJECT,
  orgId: TEAM_ORG,
  shareId: "LfX8olGVThDy",
  name: "Series A data room",
  slug: "series-a-data-room",
  description: "Everything for the round",
  docCount: 3,
  autoAddFiles: false,
  isRequest: false,
  createdDate: new Date("2026-09-01T10:00:00.000Z"),
  updatedDate: new Date("2026-09-20T10:00:00.000Z"),
};

async function get(param: string) {
  const request = new Request(`https://app.lnkdrp.com/api/projects/${encodeURIComponent(param)}`);
  return (await GET(request, { params: Promise.resolve({ projectSlug: param }) })) as Response;
}

function firstFilter(fn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return fn.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveActor.mockResolvedValue(inTeam);
  projectFindOne.mockImplementation(() => chain(null));
  projectExists.mockResolvedValue(null);
});

describe("GET /api/projects/:slug", () => {
  test("resolves a slug through the shared tenancy rule, bounded to the caller's workspace", async () => {
    projectFindOne.mockImplementation(() => chain(stored));
    const res = await get("series-a-data-room");
    expect(res.status).toBe(200);

    expect(projectFindOne).toHaveBeenCalledTimes(1);
    const filter = firstFilter(projectFindOne);
    expect(filter).toEqual(liveProjectBySlugMatch("series-a-data-room", TEAM_ORG, ME, false));
    // In a team workspace there is no by-user alternative at all: another member's pre-workspace
    // projects, and the caller's own, must not surface here.
    expect(JSON.stringify(filter)).not.toContain("userId");
    expect(filter).toMatchObject({ slug: "series-a-data-room", orgId: TEAM_ORG, isDeleted: { $ne: true } });
  });

  test("the personal workspace also reaches the caller's own pre-workspace projects, with one `$or`", async () => {
    resolveActor.mockResolvedValue(inPersonal);
    projectFindOne.mockImplementation(() => chain(stored));
    await get("Series-A-Data-Room");

    const filter = firstFilter(projectFindOne);
    // Stored slugs are lower-case, so the caller's spelling is folded before the exact match.
    expect(filter).toEqual(liveProjectBySlugMatch("series-a-data-room", PERSONAL_ORG, ME, true));
    expect(Object.keys(filter).sort()).toEqual(["$or", "isDeleted"]);
    expect(filter.$or).toEqual([
      { slug: "series-a-data-room", orgId: PERSONAL_ORG },
      { slug: "series-a-data-room", userId: ME, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
    ]);
  });

  test("a 24-hex param is looked up by id with the by-id rule, never as a slug", async () => {
    projectFindOne.mockImplementation(() => chain(stored));
    const res = await get(PROJECT.toString());
    expect(res.status).toBe(200);
    expect(firstFilter(projectFindOne)).toEqual(liveProjectByIdMatch(PROJECT, TEAM_ORG, ME, false));
    // A miss by id is a plain 404: the backfill question is only asked about slugs.
    projectFindOne.mockImplementation(() => chain(null));
    const miss = await get(new Types.ObjectId().toString());
    expect(miss.status).toBe(404);
    expect(projectExists).not.toHaveBeenCalled();
  });

  test("an unknown slug is a plain 404 with no reason attached", async () => {
    const res = await get("no-such-room");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Not found" });
    // It asked whether a slug-less legacy project could explain the miss, with the same bound.
    expect(projectExists).toHaveBeenCalledTimes(1);
    expect(firstFilter(projectExists)).toEqual(slugBackfillPendingFilter(TEAM_ORG, ME, false));
    expect(JSON.stringify(firstFilter(projectExists))).not.toContain("userId");
  });

  test("a miss while the workspace still has slug-less projects names the legacy reason", async () => {
    projectExists.mockResolvedValue({ _id: new Types.ObjectId() });
    const res = await get("old-room");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Not found", reason: "slug_backfill_pending" });
  });

  test("the body is the DTO GET /api/projects lists", async () => {
    projectFindOne.mockImplementation(() => chain(stored));
    const res = await get("series-a-data-room");
    const body = (await res.json()) as { project: Record<string, unknown> };
    expect(body.project).toEqual({
      id: PROJECT.toString(),
      shareId: "LfX8olGVThDy",
      name: "Series A data room",
      slug: "series-a-data-room",
      description: "Everything for the round",
      isRequest: false,
      docCount: 3,
      autoAddFiles: false,
      updatedDate: "2026-09-20T10:00:00.000Z",
      createdDate: "2026-09-01T10:00:00.000Z",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a request repo reports isRequest so a client can refuse it the way the list route hides it", async () => {
    projectFindOne.mockImplementation(() => chain({ ...stored, isRequest: false, requestUploadToken: "u".repeat(32) }));
    const res = await get("inbox");
    const body = (await res.json()) as { project: { isRequest: boolean } };
    expect(body.project.isRequest).toBe(true);
  });
});
