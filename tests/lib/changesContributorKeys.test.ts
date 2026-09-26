/**
 * `GET /api/changes?contributors=1` - the revision history's contributor tallies, made addressable.
 *
 * The tallies already answered "who replaced what"; they answered it with a name and a raw
 * `userId`, which is a dead end on every surface that renders them. These tests pin the two things
 * that make the rows follow-able and the one thing that stops a link from lying:
 *
 * - Both kinds carry the *shared* key (`src/lib/people/contributorKey.ts`), the same string the
 *   activity feed and the metrics card emit, so a client can compare rows across endpoints.
 * - An agent's key carries its owner. The aggregate has always grouped on `(client, userId)`, so
 *   two members who each connect Claude Code are already two rows here; before the owner was in
 *   the key they would both have serialised to `agent:claude-code` and merged back into one.
 * - A stored `agent.client` that predates `normalizeClientId` cannot produce a key, so its `href`
 *   is null rather than a link to a page that will 404.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ALICE = "6ab46f3a542dc85d9d3ba00f";
const BOB = "6ab46f3add6983534677931d";
const ORG = "6ab46f3add6983534677900a";
const DOC = new Types.ObjectId();

const resolveActor = vi.fn(async () => ({ kind: "user", userId: ALICE, orgId: ORG, personalOrgId: ORG }));
const applyTempUserHeaders = vi.fn((res: Response) => res);
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
/**
 * No locked rooms in this fixture (docs/prds/lnkdrp-locked-projects.md, decision 11).
 *
 * The by-id document match now carries an exclusion the caller computes, so without this the handler
 * would go looking for the projects collection. An empty hidden set makes the exclusion `{}`, which is
 * the state a workspace with no private room is really in, so every filter asserted below is the one it
 * was written against. The clause itself is pinned in `tests/lib/lockedProjectSurfaces.test.ts`.
 */
vi.mock("@/lib/projects/lockScope", () => ({
  hiddenProjectIds: async () => [],
  lockedHomeExclusion: () => ({}),
  lockedHomeExclusionFor: async () => ({}),
  projectGrantIds: async () => [],
  projectVisibilityClause: () => ({ $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: [] } }] }),
}));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    find: vi.fn(() => ({
      select: () => ({
        sort: () => ({ limit: () => ({ lean: async () => [{ _id: DOC, title: "Series A deck", shareId: "s1" }] }) }),
      }),
    })),
  },
}));

/** The `$group by createdByUserId` rows the member tally is built from. */
let tally: Array<Record<string, unknown>> = [];
/** The `$group by {client, userId}` rows the agent tally is built from. */
let byAgent: Array<Record<string, unknown>> = [];

vi.mock("@/lib/models/DocChange", () => ({
  DocChangeModel: {
    find: vi.fn(() => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) })),
    aggregate: vi.fn(async () => tally),
  },
}));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { aggregate: vi.fn(async () => byAgent) } }));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    find: vi.fn(() => ({
      select: () => ({
        lean: async () => [
          { _id: new Types.ObjectId(ALICE), name: "Christian Sanz", email: "christian@lnkdrp.com" },
          { _id: new Types.ObjectId(BOB), name: "Priya Nair", email: "priya@sequoiacap.com" },
        ],
      }),
    })),
  },
}));

const { GET } = await import("@/app/api/changes/route");

/** One member tally row. */
function member(userId: string | null, replacements = 3) {
  return {
    _id: userId ? new Types.ObjectId(userId) : null,
    replacements,
    docs: [DOC],
    firstAt: new Date("2026-09-01T00:00:00.000Z"),
    lastAt: new Date("2026-09-20T00:00:00.000Z"),
  };
}

/** One agent tally row. */
function agent(client: string, userId: string | null, replacements = 7) {
  return {
    _id: { client, userId: userId ? new Types.ObjectId(userId) : null },
    replacements,
    lastAt: new Date("2026-09-21T00:00:00.000Z"),
  };
}

async function changes() {
  const res = await GET(new Request("http://localhost/api/changes?contributors=1"));
  return (await res.json()) as { contributors: Array<Record<string, any>>; agents: Array<Record<string, any>> };
}

beforeEach(() => {
  tally = [member(ALICE)];
  byAgent = [agent("claude-code", ALICE)];
});

describe("contributor rows", () => {
  test("a member carries the shared person key and their page", async () => {
    const { contributors } = await changes();
    expect(contributors[0]).toMatchObject({
      userId: ALICE,
      key: `user:${ALICE}`,
      href: `/people/${ALICE}`,
      name: "Christian Sanz",
      replacements: 3,
      documents: 1,
    });
  });

  test("a replacement with no recorded member has no key and no link", async () => {
    tally = [member(null)];
    const { contributors } = await changes();
    expect(contributors[0].userId).toBeNull();
    expect(contributors[0].key).toBeNull();
    expect(contributors[0].href).toBeNull();
  });

  test("the fields that were already there are untouched", async () => {
    const { contributors } = await changes();
    expect(contributors[0].firstAt).toBe("2026-09-01T00:00:00.000Z");
    expect(contributors[0].lastAt).toBe("2026-09-20T00:00:00.000Z");
    expect(contributors[0].email).toBe("christian@lnkdrp.com");
  });
});

describe("agent rows", () => {
  test("the key carries the owner, and the href is the agent's own page", async () => {
    const { agents } = await changes();
    expect(agents[0]).toMatchObject({
      client: "claude-code",
      userId: ALICE,
      key: `agent:claude-code@${ALICE}`,
      href: `/agents/claude-code/${ALICE}`,
    });
  });

  test("the same client under two members stays two rows with two keys", async () => {
    byAgent = [agent("claude-code", ALICE, 7), agent("claude-code", BOB, 2)];
    const { agents } = await changes();
    expect(agents.map((a) => a.key)).toEqual([`agent:claude-code@${ALICE}`, `agent:claude-code@${BOB}`]);
    expect(new Set(agents.map((a) => a.href)).size).toBe(2);
  });

  test("ownerName names the member who connected it, and name keeps meaning what it did", async () => {
    const { agents } = await changes();
    expect(agents[0].ownerName).toBe("Christian Sanz");
    // `name` has always been the owner's name on this row and clients read it; renaming it would
    // have been a silent break for the sake of tidiness.
    expect(agents[0].name).toBe("Christian Sanz");
  });

  test("a credential whose creator was never recorded keys as unknown and still links", async () => {
    byAgent = [agent("claude-code", null)];
    const { agents } = await changes();
    expect(agents[0].userId).toBeNull();
    expect(agents[0].key).toBe("agent:claude-code@unknown");
    expect(agents[0].href).toBe("/agents/claude-code/unknown");
    expect(agents[0].ownerName).toBeNull();
  });

  test("a client id that is not one answers no link rather than a broken one", async () => {
    byAgent = [agent("Claude Code", ALICE)];
    const { agents } = await changes();
    expect(agents[0].client).toBe("Claude Code");
    expect(agents[0].href).toBeNull();
  });
});

describe("the tallies stay opt-in", () => {
  test("without contributors=1 neither list is in the body", async () => {
    const res = await GET(new Request("http://localhost/api/changes"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("contributors");
    expect(body).not.toHaveProperty("agents");
  });
});
