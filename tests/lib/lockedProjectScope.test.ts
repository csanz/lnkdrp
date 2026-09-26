/**
 * The locked-project visibility clause: its shape, and where it lands
 * (docs/prds/lnkdrp-locked-projects.md, decisions 1, 5, 6 and 7, Verification 1 and 2).
 *
 * Two mechanisms are pinned here, and both are the kind that fail silently when they break:
 *
 * 1. **The `$ne` form.** `{ visibility: { $ne: "locked" } }` matches a row that has no `visibility`
 *    field at all, which is every project row written before today. An equality on `"workspace"`
 *    would match NONE of them, so "optimising" the clause would hide the entire product's existing
 *    data behind a feature nobody has switched on. That mistake has already happened once in this
 *    collection: `db/migration/20260925_0003_projects_live_unique_names.mjs` exists because
 *    `isDeleted: false` is an equality that rows without the field escaped.
 *
 * 2. **That the clause lands in `$and`.** In a JS object literal a second `$or` key REPLACES the
 *    first, so a clause written as a sibling `$or` would silently delete the legacy tenancy
 *    alternative it was spread beside: the query then reads as narrower and runs as wider. That is
 *    the exact trap `tests/lib/liveProjectScope.test.ts` was written for, and a visibility clause is
 *    the worst possible thing to lose to it, so all four builders are checked with a legacy-eligible
 *    actor, where the collision is possible.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, test, vi } from "vitest";

const ORG = new Types.ObjectId("64b0c0ffee0000000000f001");
const OTHER_ORG = new Types.ObjectId("64b0c0ffee0000000000f002");
const ME = new Types.ObjectId("64b0c0ffee0000000000f003");
const PROJECT = new Types.ObjectId("64b0c0ffee0000000000f004");
const GRANTED_ROOM = new Types.ObjectId("64b0c0ffee0000000000f005");
const LOCKED_ROOM = new Types.ObjectId("64b0c0ffee0000000000f006");

/** A mongoose-ish query chain: `select`, `limit` and `lean` in the shapes lockScope uses. */
function chain<T>(result: T) {
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.limit = () => c;
  c.lean = async () => result;
  return c;
}

const grantFind = vi.fn((_filter: Record<string, unknown>) => chain([] as unknown[]));
const projectFind = vi.fn((_filter: Record<string, unknown>, _projection?: unknown, _options?: unknown) =>
  chain([] as unknown[]),
);

vi.mock("@/lib/models/ProjectMembership", () => ({
  ProjectMembershipModel: {
    // The helper skips the read when there is no connection, so the mock says there is one.
    db: { readyState: 1 },
    find: (f: Record<string, unknown>) => grantFind(f),
  },
}));
vi.mock("@/lib/models/Project", () => ({
  // Three arguments: the locked-id read passes its ceiling as a query option rather than chaining
  // `.limit()`, so the spy has to see the options to be able to assert them.
  ProjectModel: {
    find: (f: Record<string, unknown>, p?: unknown, o?: unknown) => projectFind(f, p, o),
  },
}));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));

const {
  HIDDEN_PROJECT_IDS_CAP,
  LockedProjectCapExceededError,
  hiddenProjectIds,
  lockedHomeExclusion,
  projectGrantIds,
  projectMembershipChanged,
  projectVisibilityChanged,
  projectVisibilityClause,
} = await import("@/lib/projects/lockScope");
const { allProjectsFilter, liveProjectByIdMatch, liveProjectBySlugMatch, liveProjectFilter, slugBackfillPendingFilter } =
  await import("@/lib/projects/scope");

beforeEach(() => {
  grantFind.mockClear();
  projectFind.mockClear();
  grantFind.mockImplementation(() => chain([]));
  projectFind.mockImplementation(() => chain([]));
  // Both helpers cache for ten seconds, which would otherwise carry one case's answer into the next:
  // the grants per person, and the workspace's locked ids per workspace.
  projectMembershipChanged({ orgId: ORG, userId: ME });
  projectMembershipChanged({ orgId: OTHER_ORG, userId: ME });
  projectVisibilityChanged({ orgId: ORG });
  projectVisibilityChanged({ orgId: OTHER_ORG });
});

describe("the clause pins the $ne form", () => {
  test("with no grants it is a `$ne` on visibility, never an equality on workspace", () => {
    expect(projectVisibilityClause([])).toEqual({
      $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: [] } }],
    });
  });

  test("a row with no `visibility` field satisfies it, which an equality would not", () => {
    // The assertion an "optimisation" to `visibility: "workspace"` would break, spelled out as the
    // predicate Mongo evaluates rather than as a string comparison on the clause.
    const clause = projectVisibilityClause([]);
    const arm = clause.$or[0] as { visibility: { $ne: string } };
    const legacyRow: { visibility?: string } = {};
    expect(legacyRow.visibility).toBeUndefined();
    expect(legacyRow.visibility !== arm.visibility.$ne).toBe(true);
    // And the equality form, for contrast: it matches nothing that exists today.
    expect(legacyRow.visibility === "workspace").toBe(false);
  });

  test("a grant comes back as an `_id` alternative, so a member still reaches their own room", () => {
    expect(projectVisibilityClause([GRANTED_ROOM])).toEqual({
      $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: [GRANTED_ROOM] } }],
    });
  });

  test("the source carries the sentence that says why, so the next reader does not re-derive it", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.resolve(__dirname, "../../src/lib/projects/lockScope.ts"), "utf8");
    // Comment markers dropped and whitespace collapsed, because the sentences are wrapped across
    // lines and a reflow must not be what makes this test fail.
    const prose = src.replace(/^\s*\*/gm, " ").replace(/\s+/g, " ");
    expect(prose).toContain("`$ne` ON PURPOSE");
    expect(prose).toContain("no `visibility` field at all");
    expect(prose).toContain('"optimise" this into `visibility: "workspace"`');
  });
});

describe("the clause lands in $and, never as a second $or", () => {
  /** Every builder, with a legacy-eligible actor: the only case where a sibling `$or` can collide. */
  const cases: Array<{ label: string; build: () => Promise<Record<string, unknown>> }> = [
    {
      label: "liveProjectFilter",
      build: () => liveProjectFilter(ORG, ME),
    },
    {
      label: "liveProjectByIdMatch",
      build: () => liveProjectByIdMatch(PROJECT, ORG, ME, true, ME),
    },
    {
      label: "liveProjectBySlugMatch",
      build: () => liveProjectBySlugMatch("acme-raise", ORG, ME, true, ME),
    },
    {
      label: "slugBackfillPendingFilter",
      build: () => slugBackfillPendingFilter(ORG, ME, true, ME),
    },
  ];

  test.each(cases)("$label puts the clause in $and", async ({ build }) => {
    const filter = await build();
    const and = filter.$and as Array<Record<string, unknown>>;
    expect(Array.isArray(and)).toBe(true);
    expect(and).toContainEqual(projectVisibilityClause([]));
  });

  // `liveProjectFilter` has no legacy alternative of its own: the two list routes add their own
  // tenancy `$or` around it, which is why it is the one builder without an `allowLegacyByUserId`.
  const legacyCases = cases.filter((c) => c.label !== "liveProjectFilter");

  test.each(legacyCases)("$label keeps the legacy tenancy alternative it was spread beside", async ({ build }) => {
    const filter = await build();
    const json = JSON.stringify(filter);
    // The legacy tenancy alternative is the thing a second `$or` would have eaten. Two of the three
    // carry it at the top level and one carries it inside `$and`, so this looks for the alternative
    // itself rather than for a key position.
    expect(json).toContain('"userId"');
    expect(json).toContain('"$exists":false');
  });

  test("the visibility clause is never a top-level `$or` on any builder", async () => {
    for (const { build } of cases) {
      const filter = await build();
      expect(JSON.stringify(filter.$or ?? null)).not.toContain("visibility");
    }
  });

  test("the list filter is the lock-free filter plus exactly one clause", async () => {
    const all = allProjectsFilter(ORG);
    const live = await liveProjectFilter(ORG, ME);
    // Nothing else moved: the plan cap and the list still agree on tenancy, deletion and request
    // repos, and differ by the clause and by nothing else (decision 29).
    expect((live.$and as unknown[]).slice(0, (all.$and as unknown[]).length)).toEqual(all.$and);
    expect((live.$and as unknown[]).length).toBe((all.$and as unknown[]).length + 1);
    expect(all.$and).not.toContainEqual(projectVisibilityClause([]));
  });
});

describe("projectGrantIds", () => {
  test("reads the caller's live grants on the indexed keys, `_id`-projected", async () => {
    grantFind.mockImplementation(() => chain([{ projectId: GRANTED_ROOM }]));
    expect(await projectGrantIds(ORG, ME)).toEqual([GRANTED_ROOM]);
    expect(grantFind).toHaveBeenCalledWith({ orgId: ORG, userId: ME, isDeleted: { $ne: true } });
  });

  test("fails closed on a read error: no grants, which hides a room rather than revealing one", async () => {
    grantFind.mockImplementation(() => {
      throw new Error("mongo is down");
    });
    expect(await projectGrantIds(OTHER_ORG, ME)).toEqual([]);
  });

  test("the per-request memo asks once for two filters built on one request", async () => {
    grantFind.mockImplementation(() => chain([{ projectId: GRANTED_ROOM }]));
    const request = new Request("https://app.lnkdrp.com/api/projects");
    await liveProjectFilter(ORG, ME, request);
    await liveProjectByIdMatch(PROJECT, ORG, ME, false, ME, request);
    expect(grantFind).toHaveBeenCalledTimes(1);
  });
});

describe("hiddenProjectIds and lockedHomeExclusion", () => {
  test("a workspace with no locked project adds no Mongo term at all", async () => {
    expect(await hiddenProjectIds(ORG, ME)).toEqual([]);
    expect(lockedHomeExclusion([])).toEqual({});
  });

  test("the caller's own rooms are not hidden from them", async () => {
    projectFind.mockImplementation(() => chain([{ _id: LOCKED_ROOM }, { _id: GRANTED_ROOM }]));
    grantFind.mockImplementation(() => chain([{ projectId: GRANTED_ROOM }]));
    expect(await hiddenProjectIds(ORG, ME)).toEqual([LOCKED_ROOM]);
  });

  test("the exclusion keys on a document's home, both arms of it", () => {
    expect(lockedHomeExclusion([LOCKED_ROOM])).toEqual({
      $nor: [
        { primaryProjectId: { $in: [LOCKED_ROOM] } },
        { primaryProjectId: null, projectIds: { $in: [LOCKED_ROOM] } },
      ],
    });
  });

  test("past the cap it refuses rather than returning a short array", async () => {
    // A `$nin` against a truncated array matches everything, so silent truncation here is a total
    // leak wearing the costume of a slow page (decision 6). `containedDocIds` truncates and is
    // defensible because containment is discovery; this is access.
    const rows = Array.from({ length: HIDDEN_PROJECT_IDS_CAP + 1 }, () => ({ _id: new Types.ObjectId() }));
    projectFind.mockImplementation(() => chain(rows));
    await expect(hiddenProjectIds(ORG, ME)).rejects.toBeInstanceOf(LockedProjectCapExceededError);
  });

  /**
   * The locked-id set is cached per WORKSPACE, and the invalidator is what makes a lock take effect.
   *
   * Every document surface asks this question on every request, several of them more than once, so
   * without the cache the feature would cost a `projects` read per request in every workspace
   * including the ones that have never locked anything. The direction of the staleness is the reason
   * the invalidator is not optional: on a LOCK, ten seconds of a cached "nothing is hidden" is ten
   * seconds of a non-member still seeing the room.
   */
  test("the workspace's locked ids are read once and then cached, per workspace", async () => {
    projectFind.mockImplementation(() => chain([{ _id: LOCKED_ROOM }]));
    expect(await hiddenProjectIds(ORG, ME)).toEqual([LOCKED_ROOM]);
    expect(await hiddenProjectIds(ORG, ME)).toEqual([LOCKED_ROOM]);
    expect(projectFind).toHaveBeenCalledTimes(1);

    // Another workspace is a different entry, not a hit on this one.
    await hiddenProjectIds(OTHER_ORG, ME);
    expect(projectFind).toHaveBeenCalledTimes(2);
  });

  test("locking or unlocking a room clears that cache, in this process", async () => {
    projectFind.mockImplementation(() => chain([{ _id: LOCKED_ROOM }]));
    await hiddenProjectIds(ORG, ME);
    expect(projectFind).toHaveBeenCalledTimes(1);

    projectVisibilityChanged({ orgId: ORG });
    projectFind.mockImplementation(() => chain([]));
    expect(await hiddenProjectIds(ORG, ME)).toEqual([]);
    expect(projectFind).toHaveBeenCalledTimes(2);
  });

  test("a refusal past the cap is not cached, so the next request asks again", async () => {
    const rows = Array.from({ length: HIDDEN_PROJECT_IDS_CAP + 1 }, () => ({ _id: new Types.ObjectId() }));
    projectFind.mockImplementation(() => chain(rows));
    await expect(hiddenProjectIds(ORG, ME)).rejects.toBeInstanceOf(LockedProjectCapExceededError);
    await expect(hiddenProjectIds(ORG, ME)).rejects.toBeInstanceOf(LockedProjectCapExceededError);
    expect(projectFind).toHaveBeenCalledTimes(2);
  });

  test("it asks for one row more than the cap, so the workspace sitting on it is still answered", async () => {
    projectFind.mockImplementation(() => chain([]));
    await hiddenProjectIds(ORG, ME);
    expect(projectFind).toHaveBeenCalledWith({ orgId: ORG, visibility: "locked", isDeleted: { $ne: true } }, null, {
      limit: HIDDEN_PROJECT_IDS_CAP + 1,
    });
  });
});
