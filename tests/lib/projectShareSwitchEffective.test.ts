/**
 * `PATCH /api/projects/:id { shareEnabled }` used to answer with the value it was *asked* for.
 *
 * The project switch is a switch over the project's links: the handler saves `shareEnabled` on the
 * project, then calls `setAllProjectLinksEnabled`, whose per-link write ends in
 * `syncProjectShareState` — and that rewrites `shareEnabled` in Mongo to "at least one link is
 * active". Turning the page back on cannot revive a link that has expired, nor one the sender
 * revoked on its own (`switchMayRestore`), so the derived value is false a millisecond after the
 * handler wrote true. The response was serialised from the stale in-memory document, so it said
 * `shareEnabled: true` with a `shareId`, which `lnkdrp_update_project` turns into
 * `publicPageEnabled: true` and a live-looking `publicUrl`. The agent reports "the data room is
 * back up" and forwards a URL that 404s.
 *
 * The other half: when the switch changed no link at all, nothing ran the sync, so the stale true
 * was left in Mongo too and every later read repeated it. Hence the handler syncs once itself.
 *
 * Assertions are on what the handler reads back and what it puts in the response and the activity
 * row, in the style of tests/lib/requestTokenLifecycle.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

const ORG = new Types.ObjectId();
const USER = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const connectMongo = vi.fn(async () => undefined);
const applyTempUserHeaders = vi.fn((res: unknown) => res);
const resolveActor = vi.fn(async () => ({
  kind: "user" as const,
  userId: USER.toString(),
  orgId: ORG.toString(),
  personalOrgId: ORG.toString(),
}));
const tryResolveUserActor = vi.fn(async () => null);
const recordActivity = vi.fn();

const projectFindOne = vi.fn(async (_filter: Record<string, any>) => null as any);
/** What the row looks like in Mongo *after* the link writes and the sync. */
let storedAfterSync: { shareEnabled?: unknown; shareId?: unknown } | null = null;
const projectFindById = vi.fn((_id: unknown) => ({
  select: () => ({ lean: async () => storedAfterSync }),
}));

const setAllProjectLinksEnabled = vi.fn(async () => ({ changed: 0 }));
const syncProjectShareState = vi.fn(async () => undefined);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders, tryResolveUserActor }));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (...a: any[]) => (projectFindOne as any)(...a),
    findById: (...a: any[]) => (projectFindById as any)(...a),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    exists: vi.fn(async () => null),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
    updateMany: vi.fn(async () => ({ matchedCount: 0 })),
    updateOne: vi.fn(async () => ({ matchedCount: 0 })),
  },
  allocateDocUploadVersion: vi.fn(),
}));
vi.mock("@/lib/crypto/randomBase62", () => ({
  newSecretToken: (n = 24) => "s".repeat(n),
  newShareId: () => "SHAREIDAAAAA",
  randomBase62: (n: number) => "r".repeat(n),
}));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/activity/log", () => ({
  recordActivity: (...a: any[]) => (recordActivity as any)(...a),
  agentFromRequest: () => null,
  agentLabel: () => null,
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/http/errorResponse", () => ({
  authOrRateLimitResponse: () => null,
  errorJson: (err: unknown) =>
    NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
}));
vi.mock("@/lib/share/projectLinks", () => ({
  setAllProjectLinksEnabled: (...a: any[]) => (setAllProjectLinksEnabled as any)(...a),
  syncProjectShareState: (...a: any[]) => (syncProjectShareState as any)(...a),
}));
vi.mock("@/lib/tags/service", () => ({ removeAllTagsFromTarget: vi.fn(async () => undefined) }));

const { PATCH: projectPATCH } = await import("@/app/api/projects/[projectSlug]/route");

type FakeProject = Record<string, any> & { save: ReturnType<typeof vi.fn>; isModified: (f: string) => boolean };

/** A mongoose-ish project document with enough surface for the PATCH handler. */
function fakeProject(overrides: Record<string, unknown> = {}): FakeProject {
  const touched = new Set<string>();
  const base: Record<string, any> = {
    _id: PROJECT,
    orgId: ORG,
    userId: USER,
    name: "Series A data room",
    slug: "series-a-data-room",
    description: "",
    autoAddFiles: false,
    shareEnabled: false,
    shareId: "LfX8olGVThDy",
    isRequest: false,
    ...overrides,
  };
  const doc = new Proxy(base, {
    set(target, prop, value) {
      if (typeof prop === "string" && target[prop] !== value) touched.add(prop);
      target[prop as string] = value;
      return true;
    },
  }) as FakeProject;
  base.save = vi.fn(async () => doc);
  base.isModified = (field: string) => touched.has(field);
  return doc;
}

async function callPatch(body: Record<string, unknown>) {
  const request = new Request("https://app.lnkdrp.com/api/projects/" + PROJECT.toString(), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await projectPATCH(request, { params: Promise.resolve({ projectSlug: PROJECT.toString() }) })) as Response;
}

function shareRow() {
  return recordActivity.mock.calls
    .map((c) => c[0] as any)
    .find((a) => a?.type === "share.updated" && (a?.meta as any)?.scope === "project");
}

beforeEach(() => {
  vi.clearAllMocks();
  storedAfterSync = null;
  projectFindOne.mockReset();
  setAllProjectLinksEnabled.mockResolvedValue({ changed: 0 });
});

describe("PATCH /api/projects/:id reports the share state the links settled on", () => {
  test("an enable no link can honour answers false, with no shareId to hand out", async () => {
    const project = fakeProject();
    projectFindOne.mockResolvedValue(project);
    // The default link was revoked on its own and the rest have expired: the switch restores
    // nothing, and the sync writes the derived false straight back over our save.
    storedAfterSync = { shareEnabled: false, shareId: "LfX8olGVThDy" };

    const res = await callPatch({ shareEnabled: true });
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    // Pre-fix this was `true` with a `/p/` URL the caller forwarded to recipients.
    expect(json.project.shareEnabled).toBe(false);
    expect(json.project.shareId).toBe("LfX8olGVThDy");
  });

  test("the sync runs even when the switch changed no link, so the stale true is not left in Mongo", async () => {
    const project = fakeProject();
    projectFindOne.mockResolvedValue(project);
    setAllProjectLinksEnabled.mockResolvedValue({ changed: 0 });
    storedAfterSync = { shareEnabled: false, shareId: "LfX8olGVThDy" };

    await callPatch({ shareEnabled: true });

    expect(setAllProjectLinksEnabled).toHaveBeenCalledTimes(1);
    // `syncProjectShareState` only runs per changed link inside `updateProjectLink`; with nothing
    // to change, the handler is the only thing left to repair the flag.
    expect(syncProjectShareState).toHaveBeenCalledWith(PROJECT);
  });

  test("the activity row records the state the project ended in, and the ask when they differ", async () => {
    const project = fakeProject();
    projectFindOne.mockResolvedValue(project);
    storedAfterSync = { shareEnabled: false, shareId: "LfX8olGVThDy" };

    await callPatch({ shareEnabled: true });

    const row = shareRow();
    expect(row).toBeTruthy();
    expect(row.meta.shareEnabled).toBe(false);
    expect(row.meta.requested).toBe(true);
  });

  test("an enable a link can honour still answers true, and says nothing about a request", async () => {
    const project = fakeProject();
    projectFindOne.mockResolvedValue(project);
    setAllProjectLinksEnabled.mockResolvedValue({ changed: 1 });
    storedAfterSync = { shareEnabled: true, shareId: "oCwBVXkOev3H" };

    const res = await callPatch({ shareEnabled: true });
    const json = (await res.json()) as any;

    expect(json.project.shareEnabled).toBe(true);
    // The default link the sync pointed the project at, not whatever the in-memory row carried.
    expect(json.project.shareId).toBe("oCwBVXkOev3H");
    expect(shareRow().meta.shareEnabled).toBe(true);
    expect(shareRow().meta.requested).toBeUndefined();
  });

  test("turning the page off answers false", async () => {
    const project = fakeProject({ shareEnabled: true });
    projectFindOne.mockResolvedValue(project);
    setAllProjectLinksEnabled.mockResolvedValue({ changed: 2 });
    storedAfterSync = { shareEnabled: false, shareId: "LfX8olGVThDy" };

    const res = await callPatch({ shareEnabled: false });
    const json = (await res.json()) as any;

    expect(json.project.shareEnabled).toBe(false);
    expect(shareRow().meta.shareEnabled).toBe(false);
    expect(shareRow().meta.requested).toBeUndefined();
  });

  test("a link write that fails degrades to the requested value rather than 500ing", async () => {
    const project = fakeProject();
    projectFindOne.mockResolvedValue(project);
    setAllProjectLinksEnabled.mockRejectedValue(new Error("mongo down"));

    const res = await callPatch({ shareEnabled: true });
    const json = (await res.json()) as any;

    // Best-effort is the standing contract here: the project row saved, and the next link edit
    // repairs the flag. Nothing was read back, so there is nothing better to report.
    expect(res.status).toBe(200);
    expect(json.project.shareEnabled).toBe(true);
  });

  test("a rename with no shareEnabled in the body touches neither the links nor the sync", async () => {
    const project = fakeProject({ shareEnabled: true });
    projectFindOne.mockResolvedValue(project);

    const res = await callPatch({ name: "Series B data room" });
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(setAllProjectLinksEnabled).not.toHaveBeenCalled();
    expect(syncProjectShareState).not.toHaveBeenCalled();
    expect(json.project.shareEnabled).toBe(true);
    expect(json.project.shareId).toBe("LfX8olGVThDy");
  });
});
