/**
 * The two bounds `/api/metrics/events` was missing: a workspace, and a ceiling.
 *
 * The route takes an id out of the request body and writes a row for it. The `doc_page_timing`
 * branch proves the document belongs to the caller's workspace before writing; the two project
 * branches — added later, on the same handler — never did. `projectId` was checked only with
 * `Types.ObjectId.isValid`, so a well-formed id belonging to anyone at all was accepted, and
 * `ProjectClick` has no unique index, so each call appended another row carrying two
 * caller-supplied 2048-character strings.
 *
 * Nothing about "authenticated" saved it: `resolveExistingActor` accepts an already-existing temp
 * user, and any other endpoint hands one of those out, so the identity cost one bootstrap call and
 * then bought unlimited writes against every workspace's analytics.
 *
 * Both halves are pinned as filters-issued assertions (the style of tests/lib/docMetricsScope.test.ts
 * and tests/lib/crossTenantScoping.test.ts), because the rule lives in the query the route issues,
 * not in the shape of the response.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const ORG = new Types.ObjectId().toString();
const ME = new Types.ObjectId().toString();
/** A project in a workspace the caller has no relationship with. */
const FOREIGN_PROJECT = new Types.ObjectId().toString();
const DOC = new Types.ObjectId().toString();

const { rateLimit } = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({ ok: true, remaining: 119, retryAfterSec: 0 })),
}));

const resolveExistingActor = vi.fn();
/** Stands in for "the database found no such project for this workspace". */
const projectExists = vi.fn(async (_filter: Record<string, any>) => null as unknown);
const projectViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 1 }));
const projectClickCreate = vi.fn(async (..._a: unknown[]) => ({ _id: new Types.ObjectId() }));
const docPageTimingCreate = vi.fn(async (..._a: unknown[]) => ({ _id: new Types.ObjectId() }));
const docExists = vi.fn(async (_filter: Record<string, any>) => ({ _id: new Types.ObjectId(DOC) }) as unknown);

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/actor", () => ({ resolveExistingActor }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/rateLimit")>()),
  rateLimit,
}));
vi.mock("@/lib/http/errorResponse", () => ({
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
}));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { exists: (...a: any[]) => (projectExists as any)(...a) } }));
vi.mock("@/lib/models/ProjectView", () => ({
  ProjectViewModel: { updateOne: (...a: any[]) => (projectViewUpdateOne as any)(...a) },
}));
vi.mock("@/lib/models/ProjectClick", () => ({
  ProjectClickModel: { create: (...a: any[]) => (projectClickCreate as any)(...a) },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { exists: (...a: any[]) => (docExists as any)(...a) } }));
vi.mock("@/lib/models/DocPageTiming", () => ({
  DocPageTimingModel: { create: (...a: any[]) => (docPageTimingCreate as any)(...a) },
}));
vi.mock("@/lib/models/PageTiming", () => ({ PageTimingModel: { create: vi.fn(async () => ({})) } }));
vi.mock("@/lib/models/ShareLink", () => ({
  ShareLinkModel: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));

const { POST } = await import("@/app/api/metrics/events/route");

/** A throwaway visitor identity: exactly what one bootstrap call against any endpoint yields. */
const tempActor = {
  kind: "temp",
  userId: ME,
  orgId: ORG,
  personalOrgId: ORG,
  temp: { id: ME },
  isNew: false,
};

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/metrics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveExistingActor.mockResolvedValue(tempActor as never);
  rateLimit.mockResolvedValue({ ok: true, remaining: 119, retryAfterSec: 0 });
  projectExists.mockResolvedValue(null);
  docExists.mockResolvedValue({ _id: new Types.ObjectId(DOC) });
});

describe("project_view", () => {
  test("a project the caller's workspace cannot see is refused, and nothing is written", async () => {
    const res = await post({ type: "project_view", sessionId: "s_1", projectId: FOREIGN_PROJECT, path: "/project/x" });

    expect(res.status).toBe(404);
    expect(projectViewUpdateOne).not.toHaveBeenCalled();
  });

  test("the lookup carries the workspace bound, not just the id from the body", async () => {
    await post({ type: "project_view", sessionId: "s_1", projectId: FOREIGN_PROJECT, path: "/project/x" });

    expect(projectExists).toHaveBeenCalledTimes(1);
    const filter = projectExists.mock.calls[0]?.[0] as Record<string, unknown>;
    // The id alone was the whole access decision before; the org (and "not deleted") is what makes
    // it an access decision at all.
    expect(JSON.stringify(filter)).toContain(ORG);
    expect(JSON.stringify(filter)).toContain("isDeleted");
  });

  test("a project in the caller's own workspace still records its view", async () => {
    projectExists.mockResolvedValue({ _id: new Types.ObjectId(FOREIGN_PROJECT) });

    const res = await post({ type: "project_view", sessionId: "s_1", projectId: FOREIGN_PROJECT, path: "/project/x" });

    expect(res.status).toBe(200);
    expect(projectViewUpdateOne).toHaveBeenCalledTimes(1);
  });
});

describe("project_click", () => {
  test("a foreign project cannot have rows appended to it", async () => {
    const res = await post({
      type: "project_click",
      sessionId: "s_1",
      projectId: FOREIGN_PROJECT,
      fromPath: "/project/x",
      toPath: "/doc/y",
    });

    expect(res.status).toBe(404);
    // `ProjectClick` has no unique index, so every unchecked call was another unbounded row.
    expect(projectClickCreate).not.toHaveBeenCalled();
  });

  test("a click inside the caller's own workspace is still recorded", async () => {
    projectExists.mockResolvedValue({ _id: new Types.ObjectId(FOREIGN_PROJECT) });

    const res = await post({
      type: "project_click",
      sessionId: "s_1",
      projectId: FOREIGN_PROJECT,
      fromPath: "/project/x",
      toPath: "/doc/y",
    });

    expect(res.status).toBe(200);
    expect(projectClickCreate).toHaveBeenCalledTimes(1);
  });
});

describe("the ingest ceiling", () => {
  test("every accepted call is charged to the resolved identity", async () => {
    await post({ type: "project_view", sessionId: "s_1", projectId: FOREIGN_PROJECT, path: "/project/x" });

    // Keyed on the actor, not the IP: the real senders are browser tabs, and tabs share an IP
    // behind any office NAT.
    expect(rateLimit).toHaveBeenCalledWith(expect.objectContaining({ key: `metrics:events:${ME}` }));
    const charge = (rateLimit.mock.calls as unknown as Array<[{ limit: number; windowMs: number }]>)[0]?.[0];
    expect(charge?.limit).toBeGreaterThan(0);
    expect(charge?.windowMs).toBeGreaterThan(0);
  });

  test("over the ceiling the write does not happen", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 42 });

    const res = await post({
      type: "project_click",
      sessionId: "s_1",
      projectId: FOREIGN_PROJECT,
      fromPath: "/project/x",
      toPath: "/doc/y",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(projectClickCreate).not.toHaveBeenCalled();
  });

  test("the doc timing branch is charged too — it writes a row on every call as well", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 7 });

    const res = await post({
      type: "doc_page_timing",
      sessionId: "s_1",
      docId: DOC,
      version: 1,
      pageNumber: 2,
      enteredAtMs: 1_700_000_000_000,
      leftAtMs: 1_700_000_005_000,
    });

    expect(res.status).toBe(429);
    expect(docPageTimingCreate).not.toHaveBeenCalled();
  });
});
