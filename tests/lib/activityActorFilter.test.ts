/**
 * `GET /api/activity?actor=` - the feed narrowed to one named contributor.
 *
 * `tests/lib/actorFilter.test.ts` pins the clauses; this pins the route that spreads them, which is
 * where the three ways of getting this wrong live:
 *
 * 1. **A reader's history through the back door.** The whole feature adds a query parameter that
 *    selects by `userId`, and a recipient's reads are rows with a `userId` on them. They are kept
 *    out by construction (`buildActorFilter` excludes viewer and secret rows) rather than by a plan
 *    check, so the test that matters asserts the clause is present on every plan, and that a
 *    recipient row never carries a contributor key even on Pro, where their name is visible.
 * 2. **A page that hides its own subject's work.** The workspace feed leaves out documents kept
 *    inside a room. A contributor's page is not the workspace feed, and applying that exclusion
 *    there would print a count in the header over a list missing half of it.
 * 3. **Two filters on the same axis.** `actor` and `who` both answer "whose rows", so `who` is
 *    ignored when `actor` is present. Silently: a stale `who` in a URL must not 400 a page.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ALICE = "6ab46f3a542dc85d9d3ba00f";
const BOB = "6ab46f3add6983534677931d";
const ORG = "6ab46f3add6983534677900a";
const DOC = "6ab46f3add69835346779111";
const CONTAINED = new Types.ObjectId();

const resolveActor = vi.fn(async () => ({ kind: "user", userId: ALICE, orgId: ORG, personalOrgId: ORG }));
const applyTempUserHeaders = vi.fn((res: Response) => res);
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));

let role: "owner" | "viewer" | "none" = "owner";
const requireOrgRole = vi.fn(async () =>
  role === "none" ? { ok: false as const, status: 403 as const, error: "Forbidden" } : { ok: true as const, role },
);
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));

/** Every filter `ActivityEventModel.find` was handed this test, newest last. */
let filters: Array<Record<string, unknown>> = [];
/** The rows the mocked find answers with. */
let rows: Array<Record<string, unknown>> = [];
const activityFind = vi.fn((filter: Record<string, unknown>) => {
  filters.push(filter);
  return { sort: () => ({ limit: () => ({ lean: async () => rows }) }) };
});
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { find: activityFind } }));

/** `Model.find(...).select(...).lean()`, the shape every lookup in the route uses. */
function lookup(answer: () => unknown[]) {
  return { find: vi.fn(() => ({ select: () => ({ lean: async () => answer() }) })) };
}
vi.mock("@/lib/models/User", () => ({
  UserModel: lookup(() => [
    { _id: new Types.ObjectId(ALICE), name: "Christian Sanz", email: "christian@lnkdrp.com" },
    { _id: new Types.ObjectId(BOB), name: "Priya Nair", email: "priya@sequoiacap.com" },
  ]),
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: lookup(() => [{ _id: new Types.ObjectId(DOC), title: "Series A deck", shareId: "s1", isDeleted: false }]),
}));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: lookup(() => []) }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: lookup(() => []) }));
vi.mock("@/lib/models/ProjectLinkView", () => ({ ProjectLinkViewModel: lookup(() => []) }));

const containedDocIds = vi.fn(async () => [CONTAINED]);
vi.mock("@/lib/docs/visibility", () => ({ containedDocIds }));

let plan: "free" | "pro" = "pro";
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan: vi.fn(async () => plan) }));

const { GET } = await import("@/app/api/activity/route");

/** One activity row as `.lean()` hands it over. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: new Types.ObjectId(),
    type: "doc.created",
    createdDate: new Date("2026-09-20T10:00:00.000Z"),
    userId: new Types.ObjectId(ALICE),
    actorKind: "user",
    agent: null,
    docId: new Types.ObjectId(DOC),
    projectId: null,
    title: "Series A deck",
    meta: {},
    ...over,
  };
}

async function get(query: string) {
  const res = await GET(new Request(`http://localhost/api/activity${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, any>, filter: filters[filters.length - 1] };
}

beforeEach(() => {
  filters = [];
  rows = [row()];
  plan = "pro";
  role = "owner";
  containedDocIds.mockClear();
});

describe("a malformed actor is a client error, not an empty feed", () => {
  test.each([
    "bogus",
    "user:abc",
    "user:6ab46f3a542dc85d9d3ba00", // 23 hex
    "agent:Claude Code@" + ALICE,
    "agent:claude-code@notanid",
  ])("%s answers 400", async (bad) => {
    const res = await GET(new Request(`http://localhost/api/activity?actor=${encodeURIComponent(bad)}`));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid actor. Pass user:<userId> or agent:<client>@<ownerUserId>.");
    // Refused before the database was asked anything.
    expect(filters).toHaveLength(0);
  });

  test("an absent actor is not a malformed one", async () => {
    const { status } = await get("?limit=5");
    expect(status).toBe(200);
  });
});

describe("the filter a named actor produces", () => {
  test("a person: their rows, never their agents', never their reading", async () => {
    const { status, filter } = await get(`?actor=user:${ALICE}`);
    expect(status).toBe(200);
    expect(String(filter.userId)).toBe(ALICE);
    expect(filter["agent.client"]).toEqual({ $exists: false });
    // The clause that makes an actor filter unusable as a reader's history, on every plan.
    expect(filter.actorKind).toEqual({ $nin: ["viewer", "secret"] });
  });

  test("the viewer exclusion is there on Free too", async () => {
    plan = "free";
    const { filter } = await get(`?actor=user:${BOB}`);
    expect(filter.actorKind).toEqual({ $nin: ["viewer", "secret"] });
    expect(String(filter.userId)).toBe(BOB);
  });

  test("an agent: this client under this owner", async () => {
    const { filter } = await get(`?actor=agent:claude-code@${ALICE}`);
    expect(String(filter.userId)).toBe(ALICE);
    expect(filter["agent.client"]).toBe("claude-code");
  });

  test("an agent with no recorded owner selects the rows that have none", async () => {
    const { filter } = await get("?actor=agent:claude-code@unknown");
    expect(filter.userId).toBeNull();
    expect(filter["agent.client"]).toBe("claude-code");
  });

  test("a legacy agent:<client> key is read as the unknown owner rather than refused", async () => {
    const { status, filter } = await get("?actor=agent:claude-code");
    expect(status).toBe(200);
    expect(filter.userId).toBeNull();
    expect(filter["agent.client"]).toBe("claude-code");
  });
});

describe("actor and who are the same axis", () => {
  test("who is ignored, not rejected", async () => {
    const { status, filter } = await get(`?actor=agent:claude-code@${ALICE}&who=agents`);
    expect(status).toBe(200);
    // `who=agents` would have written `{ $exists: true, $ne: null }` over the client.
    expect(filter["agent.client"]).toBe("claude-code");
    expect(String(filter.userId)).toBe(ALICE);
  });

  test("who=me still applies when no actor is named", async () => {
    const { filter } = await get("?who=me");
    expect(String(filter.userId)).toBe(ALICE);
    expect(filter["agent.client"]).toEqual({ $exists: false });
    expect(filter.actorKind).toEqual({ $nin: ["viewer", "secret"] });
  });
});

describe("a contributor's page is not the workspace feed", () => {
  test("the room-contained exclusion is skipped when an actor is named", async () => {
    const { filter } = await get(`?actor=user:${ALICE}`);
    expect(filter.docId).toBeUndefined();
    // Not merely unused: never asked for, so the page costs one query less as well.
    expect(containedDocIds).not.toHaveBeenCalled();
  });

  test("and still applies to the workspace feed", async () => {
    const { filter } = await get("?limit=5");
    expect(filter.docId).toEqual({ $nin: [CONTAINED] });
    expect(containedDocIds).toHaveBeenCalledTimes(1);
  });

  test("an explicit docId still wins over the actor", async () => {
    const { filter } = await get(`?actor=user:${ALICE}&docId=${DOC}`);
    expect(String(filter.docId)).toBe(DOC);
  });
});

describe("actor composes with the rest of the query", () => {
  test("the keyset cursor clause is still added", async () => {
    const cursor = Buffer.from(`2026-09-19T00:00:00.000Z:${new Types.ObjectId()}`, "utf8").toString("base64url");
    const { status, filter } = await get(`?actor=user:${ALICE}&cursor=${cursor}`);
    expect(status).toBe(200);
    expect(Array.isArray(filter.$or)).toBe(true);
    expect((filter.$or as unknown[]).length).toBe(2);
  });

  test("a type filter ANDs with it and replaces the hidden-row exclusion, as it does for who", async () => {
    const { filter } = await get(`?actor=user:${ALICE}&type=doc.created`);
    expect(filter.type).toEqual({ $in: ["doc.created"] });
    expect(filter.$nor).toBeUndefined();
    expect(String(filter.userId)).toBe(ALICE);
  });

  test("with no type filter the hidden instrumentation rows stay out", async () => {
    const { filter } = await get(`?actor=user:${ALICE}`);
    expect(Array.isArray(filter.$nor)).toBe(true);
  });
});

describe("the rows carry the keys the pages link with", () => {
  test("a member's own row carries their contributor key and href", async () => {
    const { body } = await get("?limit=5");
    expect(body.items[0].actor).toMatchObject({
      userId: ALICE,
      key: `user:${ALICE}`,
      href: `/people/${ALICE}`,
    });
    expect(body.items[0].agent).toBeNull();
  });

  test("an agent row carries the agent's key, its href and its owner", async () => {
    rows = [row({ actorKind: "api_key", agent: { client: "claude-code", version: "1.2.3" }, type: "doc.replaced" })];
    const { body } = await get("?limit=5");
    const item = body.items[0];
    expect(item.agent).toMatchObject({
      client: "claude-code",
      label: "Claude Code",
      key: `agent:claude-code@${ALICE}`,
      href: `/agents/claude-code/${ALICE}`,
      ownerUserId: ALICE,
    });
    // The owner is still addressable as a person: the row is the agent's work, and the member who
    // connected it is one click away.
    expect(item.actor.key).toBe(`user:${ALICE}`);
  });

  test("a system row with no member carries no key", async () => {
    rows = [row({ userId: null, actorKind: "secret" })];
    const { body } = await get("?limit=5");
    expect(body.items[0].actor.key).toBeNull();
    expect(body.items[0].actor.href).toBeNull();
  });
});

describe("a recipient is a reader, not a contributor", () => {
  /** A `share.viewed` row written by a signed-in reader: it has a userId, which is the trap. */
  function recipientRow() {
    return row({
      type: "share.viewed",
      actorKind: "viewer",
      userId: new Types.ObjectId(BOB),
      meta: { viewerKey: "a".repeat(32), shareId: "s1", viewerName: "Priya Nair", authenticated: true },
    });
  }

  test("on Free the identity gate blanks the key and the href with the name", async () => {
    plan = "free";
    rows = [recipientRow()];
    const { body } = await get("?limit=5");
    const actor = body.items[0].actor;
    expect(actor.userId).toBeNull();
    expect(actor.key).toBeNull();
    expect(actor.href).toBeNull();
    expect(body.items[0].meta.viewerName).toBeUndefined();
  });

  test("on Pro the name comes back but the contributor key does not", async () => {
    plan = "pro";
    rows = [recipientRow()];
    const { body } = await get("?limit=5");
    const actor = body.items[0].actor;
    expect(actor.userId).toBe(BOB);
    expect(actor.name).toBe("Priya Nair");
    // Their page is `readerHref`, and it is the one place their reading is listed.
    expect(actor.key).toBeNull();
    expect(actor.href).toBeNull();
    expect(body.items[0].readerHref).toContain("/metrics/viewer/");
  });
});

describe("the access checks the actor parameter rides on", () => {
  test("a non-member is refused before any actor is resolved", async () => {
    role = "none";
    const res = await GET(new Request(`http://localhost/api/activity?actor=user:${ALICE}`));
    expect(res.status).toBe(403);
    expect(filters).toHaveLength(0);
  });

  test("a temp user gets an empty feed rather than somebody else's rows", async () => {
    resolveActor.mockResolvedValueOnce({ kind: "temp", userId: "t1", orgId: ORG, personalOrgId: ORG } as never);
    const res = await GET(new Request(`http://localhost/api/activity?actor=user:${ALICE}`));
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
    expect(filters).toHaveLength(0);
  });
});
