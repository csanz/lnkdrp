/**
 * `GET /api/activity/summary?actor=` - the chart's series narrowed to one named contributor.
 *
 * The contributor pages draw a line from this route and page their rows from `GET /api/activity`.
 * Two endpoints answering "what did this contributor do" is exactly the shape in which a chart and
 * the list beneath it come to disagree, so the summary spreads the feed's own `buildActorFilter`
 * rather than re-deriving three clauses - and these tests are the feed's tests
 * (`tests/lib/activityActorFilter.test.ts`) asked of the second surface:
 *
 * 1. **A reader's history through the back door.** The parameter selects by `userId`, and a
 *    recipient's reads are rows with a `userId` on them. They are out by construction (the person
 *    branch excludes viewer and secret rows), not by a plan check, and the work-type match is a
 *    second wall that never contained a reading type.
 * 2. **A page that hides its own subject's work.** The feed's room-contained exclusion is skipped
 *    when an actor is named; this route has never applied it, so a `docId` clause appearing in its
 *    `$match` would be the two surfaces drifting apart.
 * 3. **Tenancy.** `orgId` comes from the session, never from the query, so an actor key naming a
 *    member of another workspace selects nothing instead of crossing into it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId().toString();
const ALICE = new Types.ObjectId().toString();
const BOB = new Types.ObjectId().toString();

const connectMongo = vi.fn(async () => undefined);
/** Every pipeline the route sent, in order. */
let pipelines: Array<Array<Record<string, unknown>>> = [];
const aggregate = vi.fn(async (pipeline: Array<Record<string, unknown>>) => {
  pipelines.push(pipeline);
  return rowsFor(pipeline);
});

let session: Record<string, unknown> = { kind: "user", orgId: ORG, userId: ALICE };
const resolveActor = vi.fn(async () => session);
const applyTempUserHeaders = vi.fn((res: unknown) => res);
let role: "ok" | "none" = "ok";
const requireOrgRole = vi.fn(async () =>
  role === "none" ? { ok: false as const, status: 403 as const, error: "Forbidden" } : { ok: true as const },
);

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { aggregate } }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole }));

/**
 * The feed's room-contained lookup, stubbed only so the test can assert it is never reached.
 *
 * The summary route does not import it today. If someone gives it one, this mock is what turns
 * that into a failing test rather than a silent divergence from the feed.
 */
const containedDocIds = vi.fn(async () => [new Types.ObjectId()]);
vi.mock("@/lib/docs/visibility", () => ({ containedDocIds }));

const { GET } = await import("@/app/api/activity/summary/route");

/** One stored event, in the few fields the route's `$match` can look at. */
type Event = { at: string; type: string; userId?: string | null; client?: string | null; actorKind?: string };

let events: Event[] = [];

/** The `$match` stage of a pipeline, which is where every clause under test ends up. */
function matchOf(pipeline: Array<Record<string, unknown>>): Record<string, any> {
  const stage = pipeline.find((s) => s.$match) as { $match: Record<string, unknown> } | undefined;
  if (!stage) throw new Error("no $match in pipeline");
  return stage.$match;
}

/** The `$match` the route built for this request (both pipelines share it). */
function lastMatch(): Record<string, any> {
  const last = pipelines[pipelines.length - 1];
  if (!last) throw new Error("no pipeline was run");
  return matchOf(last);
}

/** Does this event satisfy the clauses the route wrote? A small stand-in for Mongo's matcher. */
function matches(e: Event, m: Record<string, any>): boolean {
  if (new Date(e.at).getTime() < (m.createdDate.$gte as Date).getTime()) return false;
  if (!(m.type.$in as string[]).includes(e.type)) return false;
  if ("userId" in m) {
    const want = m.userId === null ? null : String(m.userId);
    if ((e.userId ?? null) !== want) return false;
  }
  const client = m["agent.client"];
  if (client !== undefined) {
    if (typeof client === "string") {
      if ((e.client ?? null) !== client) return false;
    } else if (client.$exists === false) {
      if (e.client) return false;
    }
  }
  const kind = m.actorKind;
  if (kind?.$nin && kind.$nin.includes(e.actorKind ?? "user")) return false;
  return true;
}

/** Group the surviving events the two ways the route asks for. */
function rowsFor(pipeline: Array<Record<string, unknown>>): Array<{ _id: Record<string, unknown>; count: number }> {
  const m = matchOf(pipeline);
  const perDay = JSON.stringify(pipeline).includes("$dateToString");
  const out = new Map<string, { _id: Record<string, unknown>; count: number }>();
  for (const e of events.filter((ev) => matches(ev, m))) {
    const _id = perDay
      ? { day: e.at.slice(0, 10), type: e.type, agent: Boolean(e.client) }
      : { type: e.type, client: e.client ?? null };
    const key = JSON.stringify(_id);
    const prev = out.get(key);
    out.set(key, { _id, count: (prev?.count ?? 0) + 1 });
  }
  return Array.from(out.values());
}

async function get(query: string) {
  const res = await GET(new Request(`http://localhost/api/activity/summary${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  pipelines = [];
  events = [];
  role = "ok";
  session = { kind: "user", orgId: ORG, userId: ALICE };
  containedDocIds.mockClear();
  aggregate.mockClear();
});

describe("a malformed actor is a client error, not a flat line", () => {
  test.each([
    "bogus",
    "user:abc",
    `agent:Claude Code@${ALICE}`,
    "agent:claude-code@notanid",
  ])("%s answers 400 with the feed's wording", async (bad) => {
    const { status, body } = await get(`?actor=${encodeURIComponent(bad)}`);
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid actor. Pass user:<userId> or agent:<client>@<ownerUserId>.");
    // Refused before the database was asked anything.
    expect(aggregate).not.toHaveBeenCalled();
  });

  test("an absent actor is not a malformed one", async () => {
    const { status } = await get("?days=30");
    expect(status).toBe(200);
    expect(lastMatch().userId).toBeUndefined();
  });
});

describe("the clauses a named actor produces", () => {
  test("a person: their rows, never their agents', never their reading", async () => {
    const { status } = await get(`?actor=user:${ALICE}`);
    expect(status).toBe(200);
    const m = lastMatch();
    expect(String(m.userId)).toBe(ALICE);
    expect(m["agent.client"]).toEqual({ $exists: false });
    // The clause that makes the actor parameter unusable as a reader's history, on every plan.
    expect(m.actorKind).toEqual({ $nin: ["viewer", "secret"] });
  });

  test("an agent: this client under this owner", async () => {
    await get(`?actor=agent:claude-code@${ALICE}`);
    const m = lastMatch();
    expect(String(m.userId)).toBe(ALICE);
    expect(m["agent.client"]).toBe("claude-code");
  });

  test("an agent with no recorded owner selects the rows that have none", async () => {
    await get("?actor=agent:claude-code@unknown");
    expect(lastMatch().userId).toBeNull();
    expect(lastMatch()["agent.client"]).toBe("claude-code");
  });

  test("a legacy agent:<client> key is read as the unknown owner rather than refused", async () => {
    const { status } = await get("?actor=agent:claude-code");
    expect(status).toBe(200);
    expect(lastMatch().userId).toBeNull();
  });

  test("both pipelines carry the same clauses, so the tiles and the line cannot disagree", async () => {
    await get(`?actor=user:${ALICE}`);
    expect(pipelines).toHaveLength(2);
    expect(matchOf(pipelines[0]!)).toEqual(matchOf(pipelines[1]!));
  });
});

describe("a contributor's series is not the workspace feed's", () => {
  test("no room-contained exclusion is applied, or even asked for", async () => {
    await get(`?actor=user:${ALICE}`);
    expect(lastMatch().docId).toBeUndefined();
    expect(containedDocIds).not.toHaveBeenCalled();
  });

  test("nor on the unfiltered workspace query", async () => {
    await get("?days=7");
    expect(lastMatch().docId).toBeUndefined();
    expect(containedDocIds).not.toHaveBeenCalled();
  });
});

describe("tenancy comes from the session, never from the key", () => {
  test("an actor in another workspace does not move the orgId", async () => {
    const other = new Types.ObjectId().toString();
    await get(`?actor=user:${other}`);
    const m = lastMatch();
    expect(String(m.orgId)).toBe(ORG);
    expect(String(m.userId)).toBe(other);
  });

  test("a non-member is refused before any actor is resolved", async () => {
    role = "none";
    const { status } = await get(`?actor=user:${ALICE}`);
    expect(status).toBe(403);
    expect(aggregate).not.toHaveBeenCalled();
  });

  test("a temp user gets zeros rather than somebody else's series", async () => {
    session = { kind: "temp", orgId: ORG, userId: "t1" };
    const { status, body } = await get(`?days=14&actor=user:${ALICE}`);
    expect(status).toBe(200);
    expect(body.counts.docsAdded).toBe(0);
    expect(body.series).toHaveLength(14);
    expect(aggregate).not.toHaveBeenCalled();
  });
});

describe("the numbers the chart draws", () => {
  /** Today and two days back, as day keys, so the events land inside any window under test. */
  function dayKey(back: number): string {
    return new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  }

  beforeEach(() => {
    events = [
      // The agent's work, under Alice's credential.
      { at: `${dayKey(1)}T10:00:00.000Z`, type: "doc.created", userId: ALICE, client: "claude-code", actorKind: "api_key" },
      { at: `${dayKey(1)}T11:00:00.000Z`, type: "doc.replaced", userId: ALICE, client: "claude-code", actorKind: "api_key" },
      { at: `${dayKey(3)}T09:00:00.000Z`, type: "doc.created", userId: ALICE, client: "claude-code", actorKind: "api_key" },
      // Alice's own work in the app.
      { at: `${dayKey(2)}T12:00:00.000Z`, type: "share_link.created", userId: ALICE, client: null, actorKind: "user" },
      // A colleague's, which belongs on neither of Alice's pages.
      { at: `${dayKey(2)}T13:00:00.000Z`, type: "doc.created", userId: BOB, client: null, actorKind: "user" },
      // Alice reading her own link back as a recipient: a row with her userId on it.
      { at: `${dayKey(2)}T14:00:00.000Z`, type: "share.viewed", userId: ALICE, client: null, actorKind: "viewer" },
    ];
  });

  test("an agent's series counts the agent's work and only that", async () => {
    const { body } = await get(`?days=14&actor=agent:claude-code@${ALICE}`);
    expect(body.counts).toMatchObject({ docsAdded: 2, docsReplaced: 1, linksCreated: 0 });
    const nonZero = (body.series as Array<Record<string, number>>).filter((p) => p.total > 0);
    expect(nonZero.map((p) => p.total)).toEqual([1, 2]);
  });

  test("a person's series excludes the work their agents did under their credential", async () => {
    const { body } = await get(`?days=14&actor=user:${ALICE}`);
    expect(body.counts).toMatchObject({ docsAdded: 0, docsReplaced: 0, linksCreated: 1 });
    const total = (body.series as Array<Record<string, number>>).reduce((sum, p) => sum + p.total, 0);
    expect(total).toBe(1);
  });

  test("and never their reading, which carries their userId too", async () => {
    // `share.viewed` is outside `ACTIVITY_WORK_TYPES` and the actorKind clause bars it as well:
    // both walls have to fall before a recipient row could reach this series.
    const { body } = await get(`?days=14&actor=user:${ALICE}`);
    expect(body.actors.total).toBe(1);
    expect((lastMatch().type.$in as string[]).includes("share.viewed")).toBe(false);
    expect(lastMatch().actorKind).toEqual({ $nin: ["viewer", "secret"] });
  });

  test("with no actor it is still the whole workspace", async () => {
    const { body } = await get("?days=14");
    expect(body.counts).toMatchObject({ docsAdded: 3, docsReplaced: 1, linksCreated: 1 });
  });
});
