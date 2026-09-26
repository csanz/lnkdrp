/**
 * The header of a contributor's page: what it counts, what it links to, and when it refuses.
 *
 * Four decisions are pinned here because each of them is a thing the page would quietly get wrong:
 *
 * - **Empty means 404, not an empty page.** A profile with no rows returns null, and that is the
 *   only thing stopping `/people/<any 24 hex>` from rendering for a member of another workspace.
 *   The emptiness check is a tenancy check.
 * - **`workActions` is a subset of `totalActions`.** The tiles count work; the total counts every
 *   row the feed below would show. A reader's view is in neither, but a `share.updated` is in the
 *   total and in `workActions` with no tile of its own, and the page's "Other work" line depends
 *   on the difference being real.
 * - **A deleted document keeps its line and loses its link.** The action still happened.
 * - **A person's agents are keyed with that person as owner**, which is what makes "Agents
 *   connected by this person" lead to pages about *their* Claude Code and not somebody else's.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const ALICE = new Types.ObjectId("6ab46f3a542dc85d9d3ba00f");
const GHOST = new Types.ObjectId("6ab46f3add6983534677931d");
const DOC_LIVE = new Types.ObjectId();
const DOC_GONE = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

/** What each of the four aggregates should return on this run. */
let typeRows: unknown[] = [];
let docRows: unknown[] = [];
let projectRows: unknown[] = [];
let agentRows: unknown[] = [];
let docs: unknown[] = [];
let projects: unknown[] = [];
let users: Array<Record<string, unknown>> = [];

/** Route each pipeline to its fixture by what it groups on, the way Mongo would tell them apart. */
function aggregate(pipeline: Array<Record<string, any>>): Promise<unknown[]> {
  const group = pipeline.find((s) => s.$group)?.$group;
  const match = pipeline.find((s) => s.$match)?.$match ?? {};
  if (group?._id === "$type") return Promise.resolve(typeRows);
  if (group?._id === "$agent.client") return Promise.resolve(agentRows);
  if (group?._id === "$docId") return Promise.resolve(match.docId ? docRows : []);
  if (group?._id === "$projectId") return Promise.resolve(match.projectId ? projectRows : []);
  return Promise.resolve([]);
}

vi.mock("@/lib/models/ActivityEvent", () => ({
  ActivityEventModel: { aggregate: (pipeline: Array<Record<string, any>>) => aggregate(pipeline) },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { find: () => ({ select: () => ({ lean: async () => docs }) }) },
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: { find: () => ({ select: () => ({ lean: async () => projects }) }) },
}));
/**
 * No locked rooms in these fixtures (docs/prds/lnkdrp-locked-projects.md, decision 14).
 *
 * A contributor's project list is named through `projectNamesFor` now, which asks who is reading. This
 * file is about the aggregates, so the grant read is stubbed empty: every room is visible, and the
 * expectations below are the ones they were written as.
 */
vi.mock("@/lib/models/ProjectMembership", () => ({
  ProjectMembershipModel: { find: () => ({ select: () => ({ lean: async () => [] }) }), db: { readyState: 1 } },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    find: (q: { _id?: { $in?: Types.ObjectId[] } }) => ({
      select: () => ({
        lean: async () => {
          const want = new Set((q?._id?.$in ?? []).map((v) => String(v)));
          return users.filter((u) => want.has(String(u._id)));
        },
      }),
    }),
    findById: (id: Types.ObjectId) => ({
      select: () => ({ lean: async () => users.find((u) => String(u._id) === String(id)) ?? null }),
    }),
  },
}));

const { loadActorProfile, resolveAgentOwner } = await import("@/lib/people/profile");

const AT = (s: string) => new Date(s);

beforeEach(() => {
  typeRows = [];
  docRows = [];
  projectRows = [];
  agentRows = [];
  docs = [];
  projects = [];
  users = [{ _id: ALICE, name: "Alice Ng", email: "alice@example.com" }];
});

describe("a person's profile", () => {
  beforeEach(() => {
    typeRows = [
      { _id: "doc.created", n: 3, first: AT("2026-09-01T00:00:00Z"), last: AT("2026-09-20T00:00:00Z") },
      { _id: "share_link.created", n: 2, first: AT("2026-09-05T00:00:00Z"), last: AT("2026-09-21T00:00:00Z") },
      // Work, counted, with no tile of its own: the page's "Other work" line is this row.
      { _id: "share.updated", n: 1, first: AT("2026-09-10T00:00:00Z"), last: AT("2026-09-10T00:00:00Z") },
      // Not work: in the total, out of the tiles.
      { _id: "share.viewed", n: 4, first: AT("2026-08-20T00:00:00Z"), last: AT("2026-09-22T00:00:00Z") },
    ];
  });

  test("counts, buckets and the date range come from one grouped read", async () => {
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res).not.toBeNull();
    expect(res!.totalActions).toBe(10);
    expect(res!.workActions).toBe(6);
    expect(res!.workActions).toBeLessThanOrEqual(res!.totalActions);
    expect(res!.buckets).toEqual({
      docsAdded: 3,
      docsReplaced: 0,
      linksCreated: 2,
      docsRemoved: 0,
      projectsCreated: 0,
    });
    // "Other work" on the page is workActions minus the tiles: the one `share.updated`.
    const tiled = Object.values(res!.buckets).reduce((a, b) => a + b, 0);
    expect(res!.workActions - tiled).toBe(1);
    expect(res!.firstAt).toBe("2026-08-20T00:00:00.000Z");
    expect(res!.lastAt).toBe("2026-09-22T00:00:00.000Z");
  });

  test("byType lists work types only, biggest first", async () => {
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.byType).toEqual([
      { type: "doc.created", count: 3 },
      { type: "share_link.created", count: 2 },
      { type: "share.updated", count: 1 },
    ]);
    expect(res!.byType.map((t) => t.type)).not.toContain("share.viewed");
  });

  test("identity, key and href", async () => {
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.kind).toBe("person");
    expect(res!.name).toBe("Alice Ng");
    expect(res!.email).toBe("alice@example.com");
    expect(res!.key).toBe(`user:${ALICE}`);
    expect(res!.href).toBe(`/people/${ALICE}`);
    expect(res!.client).toBeNull();
    expect(res!.owner).toBeNull();
  });

  test("a member with no name left is called by the local part of their address", async () => {
    users = [{ _id: ALICE, name: "", email: "alice@example.com" }];
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.name).toBe("alice");
  });

  test("a member whose account is gone keeps their page and is named as a member", async () => {
    users = [];
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.name).toBe("A member");
    expect(res!.email).toBeNull();
    expect(res!.href).toBe(`/people/${ALICE}`);
  });

  test("a deleted document keeps its line and loses its link", async () => {
    docRows = [
      { _id: DOC_LIVE, n: 2, last: AT("2026-09-20T00:00:00Z") },
      { _id: DOC_GONE, n: 1, last: AT("2026-09-19T00:00:00Z") },
    ];
    docs = [
      { _id: DOC_LIVE, title: "Series A deck", isDeleted: false },
      { _id: DOC_GONE, title: "Old draft", isDeleted: true },
    ];
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.docs).toEqual([
      {
        id: String(DOC_LIVE),
        title: "Series A deck",
        deleted: false,
        actions: 2,
        lastAt: "2026-09-20T00:00:00.000Z",
        href: `/doc/${DOC_LIVE}`,
      },
      {
        id: String(DOC_GONE),
        title: "Old draft",
        deleted: true,
        actions: 1,
        lastAt: "2026-09-19T00:00:00.000Z",
        href: null,
      },
    ]);
  });

  test("a document purged outright is still listed, untitled and unlinked", async () => {
    docRows = [{ _id: DOC_GONE, n: 1, last: AT("2026-09-19T00:00:00Z") }];
    docs = [];
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.docs[0]).toMatchObject({ title: null, deleted: true, href: null });
  });

  test("projects are named and linked", async () => {
    projectRows = [{ _id: PROJECT, n: 4, last: AT("2026-09-18T00:00:00Z") }];
    projects = [{ _id: PROJECT, name: "Fundraising" }];
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.projects).toEqual([
      {
        id: String(PROJECT),
        name: "Fundraising",
        actions: 4,
        lastAt: "2026-09-18T00:00:00.000Z",
        href: `/project/${PROJECT}`,
      },
    ]);
  });

  test("their agents are keyed with them as owner, so the links lead to their agent's page", async () => {
    agentRows = [
      { _id: "claude-code", n: 12, last: AT("2026-09-22T00:00:00Z") },
      { _id: "gemini-cli", n: 3, last: AT("2026-09-11T00:00:00Z") },
    ];
    const res = await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } });
    expect(res!.agents).toEqual([
      {
        key: `agent:claude-code@${ALICE}`,
        client: "claude-code",
        label: "Claude Code",
        actions: 12,
        lastAt: "2026-09-22T00:00:00.000Z",
        href: `/agents/claude-code/${ALICE}`,
      },
      {
        key: `agent:gemini-cli@${ALICE}`,
        client: "gemini-cli",
        label: "Gemini CLI",
        actions: 3,
        lastAt: "2026-09-11T00:00:00.000Z",
        href: `/agents/gemini-cli/${ALICE}`,
      },
    ]);
  });
});

describe("an agent's profile", () => {
  beforeEach(() => {
    typeRows = [{ _id: "doc.created", n: 9, first: AT("2026-09-02T00:00:00Z"), last: AT("2026-09-22T00:00:00Z") }];
  });

  test("is named by its client label, and says who connected it", async () => {
    const res = await loadActorProfile({
      orgId: ORG,
      viewerUserId: String(ALICE),
      key: { kind: "agent", client: "claude-code", ownerUserId: String(ALICE) },
    });
    expect(res!.kind).toBe("agent");
    expect(res!.name).toBe("Claude Code");
    expect(res!.client).toBe("claude-code");
    expect(res!.email).toBeNull();
    expect(res!.key).toBe(`agent:claude-code@${ALICE}`);
    expect(res!.href).toBe(`/agents/claude-code/${ALICE}`);
    expect(res!.owner).toEqual({
      userId: String(ALICE),
      name: "Alice Ng",
      email: "alice@example.com",
      href: `/people/${ALICE}`,
    });
    // An agent has no agents of its own; the list is always empty rather than absent.
    expect(res!.agents).toEqual([]);
  });

  test("an unknown owner is a real contributor with nowhere to link", async () => {
    const res = await loadActorProfile({
      orgId: ORG,
      viewerUserId: String(ALICE),
      key: { kind: "agent", client: "claude-code", ownerUserId: null },
    });
    expect(res!.key).toBe("agent:claude-code@unknown");
    expect(res!.owner).toEqual({ userId: null, name: null, email: null, href: null });
  });
});

describe("resolveAgentOwner", () => {
  test("unknown owners have no name and no page", async () => {
    expect(await resolveAgentOwner(null)).toEqual({ userId: null, name: null, email: null, href: null });
    expect(await resolveAgentOwner("")).toEqual({ userId: null, name: null, email: null, href: null });
  });

  test("a deleted member keeps their page and loses their name", async () => {
    users = [];
    expect(await resolveAgentOwner(String(GHOST))).toEqual({
      userId: String(GHOST),
      name: null,
      email: null,
      href: `/people/${GHOST}`,
    });
  });
});

describe("nothing here", () => {
  test("a contributor with no rows in this workspace is null, so the route can 404", async () => {
    typeRows = [];
    expect(await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "person", userId: String(ALICE) } })).toBeNull();
    expect(
      await loadActorProfile({ orgId: ORG, viewerUserId: String(ALICE), key: { kind: "agent", client: "claude-code", ownerUserId: null } }),
    ).toBeNull();
  });
});
