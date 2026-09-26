/**
 * Which channels an event reaches, and how many posts a minute a channel takes
 * (docs/prds/lnkdrp-slack.md, decisions 2 and 10, verification 9 and 13).
 *
 * Two halves. The first drives the pure `routeSlackConnections` rule. The second drives the real
 * `enqueueSlackPosts` over a mocked database, because the owner's question is not about the rule in
 * isolation: it is about which channel a row actually lands against once the stored connection rows,
 * `serializeSlackConnection` and `routingFor` have all had their say. Only the database and the two
 * things that would reach the outside world (the webhook post, the debug logger) are mocked.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/**
 * Everything the mocked database answers with, plus two tripwires: `posts` must stay empty (no test
 * here may reach a webhook) and `errors` must stay empty, because `enqueueSlackPosts` swallows every
 * throw and returns 0. Without that second tripwire a broken mock reads exactly like "routed nowhere".
 */
const db = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  doc: null as Record<string, unknown> | null,
  lockedProjectIds: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  dedupeKeys: new Set<string>(),
  insertOptions: [] as unknown[],
  updates: [] as Array<{ filter: Record<string, any>; update: Record<string, any> }>,
  modifiedCount: 0,
  seq: 0,
  posts: [] as unknown[],
  errors: [] as unknown[],
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));

vi.mock("@/lib/debug", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  debugLog: () => undefined,
  debugError: (...args: unknown[]) => {
    db.errors.push(args);
  },
}));

// A tripwire, not a stub: nothing in this file may post, so reaching here is a test bug.
vi.mock("@/lib/slack/post", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postToSlackWebhook: async (...args: unknown[]) => {
    db.posts.push(args);
    throw new Error("a routing test tried to post to Slack");
  },
}));

vi.mock("@/lib/models/SlackConnection", () => ({
  SlackConnectionModel: {
    // Faithful to the real query in `enqueueSlackPosts`, which asks for `status: "active"`. That
    // matters: a revoked channel never reaches `routeSlackConnections` at all.
    find: (filter: Record<string, any> = {}) => ({
      lean: async () =>
        db.connections.filter((c) => {
          if (filter.orgId && String(c.orgId) !== String(filter.orgId)) return false;
          if (filter.status && c.status !== filter.status) return false;
          return true;
        }),
    }),
    updateOne: async () => ({ acknowledged: true }),
  },
}));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: { findOne: () => ({ select: () => ({ lean: async () => db.doc }) }) },
}));

vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    find: (filter: Record<string, any> = {}) => ({
      select: () => ({
        lean: async () => {
          const asked = (filter?._id?.$in ?? []).map(String);
          return db.lockedProjectIds.filter((id) => asked.includes(id)).map((id) => ({ _id: id }));
        },
      }),
    }),
  },
}));

vi.mock("@/lib/models/SlackOutbox", () => ({
  SlackOutboxModel: {
    // The unique index on `dedupeKey` is the point of the model, so the mock enforces it and fails
    // the way Mongo does: code 11000, with the rows that did land on `insertedDocs`.
    insertMany: async (docs: Array<Record<string, unknown>>, options: unknown) => {
      db.insertOptions.push(options);
      const landed: Array<Record<string, unknown>> = [];
      let duplicate = false;
      for (const d of docs) {
        const key = String(d.dedupeKey);
        if (db.dedupeKeys.has(key)) {
          duplicate = true;
          continue;
        }
        db.dedupeKeys.add(key);
        const row = { ...d, _id: `row-${++db.seq}` };
        db.inserted.push(row);
        landed.push(row);
      }
      if (duplicate) {
        const err = new Error("E11000 duplicate key error") as Error & { code?: number; insertedDocs?: unknown[] };
        err.code = 11000;
        err.insertedDocs = landed;
        throw err;
      }
      return landed;
    },
    updateMany: async (filter: Record<string, any>, update: Record<string, any>) => {
      db.updates.push({ filter, update });
      return { modifiedCount: db.modifiedCount };
    },
    // A sweep with nothing due: enough for the drain to reach its claim query and stop, which is
    // all the recovery test needs.
    find: () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }), lean: async () => [] }) }),
  },
}));

import { burstAllowance, routeSlackConnections, SLACK_BURST_PER_MINUTE, type RoutableConnection } from "@/lib/slack/routing";
import { serializeSlackConnection, SLACK_EVENT_KEYS, type SlackEventKey } from "@/lib/slack/connections";
import { slackBurstMessage } from "@/lib/slack/messages";
import { drainSlackOutbox, enqueueSlackPosts, recoverStaleSlackClaims, type SlackOutboxEvent } from "@/lib/slack/outbox";
import { CLAIM_STALE_MS } from "@/lib/notifications/queue";
import type { SlackConnection } from "@/lib/models/SlackConnection";

const on = { views: true, briefs: true, docUpdates: true, requests: true, docs: true };
const conn = (id: string, extra: Partial<RoutableConnection> = {}): RoutableConnection => ({ id, isDefault: false, status: "active", projectIds: [], events: { ...on }, ...extra });

describe("routing", () => {
  const deals = conn("deals", { isDefault: true });
  const acme = conn("acme", { projectIds: ["p-acme"] });
  const north = conn("north", { projectIds: ["p-north"] });

  test("a workspace with only a default sends everything there", () => {
    expect(routeSlackConnections([deals], "views", []).map((c) => c.id)).toEqual(["deals"]);
    expect(routeSlackConnections([deals], "views", ["p-acme"]).map((c) => c.id)).toEqual(["deals"]);
  });

  test("a document in a mapped project posts only to that channel", () => {
    expect(routeSlackConnections([deals, acme, north], "views", ["p-acme"]).map((c) => c.id)).toEqual(["acme"]);
  });

  test("a document in two mapped rooms posts to both; unmapped goes to the default", () => {
    expect(routeSlackConnections([deals, acme, north], "briefs", ["p-acme", "p-north"]).map((c) => c.id)).toEqual(["acme", "north"]);
    expect(routeSlackConnections([deals, acme, north], "briefs", ["p-other"]).map((c) => c.id)).toEqual(["deals"]);
    expect(routeSlackConnections([deals, acme, north], "briefs", []).map((c) => c.id)).toEqual(["deals"]);
  });

  test("a document in one mapped room and one unmapped room posts only to the mapped channel", () => {
    // The owner's second half at the pure level: one mapped project is enough to take the whole
    // event out of the catch-all, even when the document also sits somewhere nothing is routed.
    expect(routeSlackConnections([deals, acme, north], "docs", ["p-acme", "p-other"]).map((c) => c.id)).toEqual(["acme"]);
  });

  test("a switch off on a mapped channel makes that room quiet, it does not move it to the catch-all", () => {
    // Switching a kind off on a data room's channel is a person saying "not these, not here". The
    // rule used to read the switch in the same pass as `status`, which dropped the channel before
    // the mapping step: `mapped` came back empty and the default took the event, so the room went
    // louder, in the channel the whole Slack workspace reads. Off means quiet.
    const quiet = conn("acme", { projectIds: ["p-acme"], events: { ...on, views: false } });
    expect(routeSlackConnections([deals, quiet], "views", ["p-acme"])).toEqual([]);
    // Only that kind, and only that channel: the same room's other kinds still post to it, and an
    // unrelated unmapped room still reaches the default.
    expect(routeSlackConnections([deals, quiet], "briefs", ["p-acme"]).map((c) => c.id)).toEqual(["acme"]);
    expect(routeSlackConnections([deals, quiet], "views", ["p-other"]).map((c) => c.id)).toEqual(["deals"]);
    // Two channels for one document, one of them off: the on one still posts and the off one's
    // share of the event is not handed to the catch-all either.
    const twoRooms = routeSlackConnections([deals, quiet, north], "views", ["p-acme", "p-north"]);
    expect(twoRooms.map((c) => c.id)).toEqual(["north"]);
  });

  test("a revoked channel receives nothing; the default can be skipped too", () => {
    const gone = conn("deals", { isDefault: true, status: "revoked" });
    expect(routeSlackConnections([gone, acme], "views", [])).toEqual([]);
    const defOff = conn("deals", { isDefault: true, events: { ...on, docUpdates: false } });
    expect(routeSlackConnections([defOff, acme], "docUpdates", [])).toEqual([]);
    expect(routeSlackConnections([], "views", ["p-acme"])).toEqual([]);
  });

  test("a contained document goes to its room's channel or nowhere, never the catch-all", () => {
    expect(routeSlackConnections([deals, acme, north], "views", ["p-acme"], { allowDefault: false }).map((c) => c.id)).toEqual(["acme"]);
    expect(routeSlackConnections([deals, acme, north], "views", ["p-other"], { allowDefault: false })).toEqual([]);
    expect(routeSlackConnections([deals], "views", [], { allowDefault: false })).toEqual([]);
  });

  test("disconnecting a mapped channel sends its projects back to the default", () => {
    expect(routeSlackConnections([deals, north], "views", ["p-acme"]).map((c) => c.id)).toEqual(["deals"]);
  });
});

describe("a connection stored before the new-documents switch existed", () => {
  // The live workspace's two rows both predate the `docs` key. A `.lean()` read skips schema
  // defaults, so the raw row really does come back without it; `serializeSlackConnection` is the
  // only thing standing between that and every new-document event being dropped.
  const legacy = {
    _id: new Types.ObjectId(),
    teamName: "LNKDRP",
    channelName: "#sharelinks",
    isDefault: true,
    projectIds: [],
    events: { views: true, briefs: true, docUpdates: true, requests: true },
    status: "active",
  } as unknown as SlackConnection;

  test("reads as on, so new documents still post", () => {
    expect((legacy.events as Record<string, unknown>).docs).toBeUndefined();
    expect(serializeSlackConnection(legacy).events).toEqual({ views: true, briefs: true, docUpdates: true, requests: true, docs: true });
  });

  test("an events object that is missing entirely still reads as every switch on", () => {
    const bare = { ...legacy, events: undefined } as unknown as SlackConnection;
    expect(serializeSlackConnection(bare).events).toEqual({ views: true, briefs: true, docUpdates: true, requests: true, docs: true });
  });

  test("only an explicit false turns a switch off", () => {
    const off = { ...legacy, events: { ...(legacy.events as object), docs: false } } as unknown as SlackConnection;
    expect(serializeSlackConnection(off).events.docs).toBe(false);
  });
});

/**
 * The owner's question, end to end: create a data room, map it to its own channel, and see that
 * documents filed there reach that channel and only that channel.
 *
 * Every test asserts on the `connectionId` of the rows that were written, because that field is the
 * only thing on an outbox row that says where the post is going. Absence is asserted as hard as
 * presence: the catch-all's id must not appear.
 */
describe("enqueueSlackPosts, over a mocked database", () => {
  const orgId = new Types.ObjectId();
  const dataRoom = new Types.ObjectId(); // mapped to the dedicated channel
  const fundraising = new Types.ObjectId(); // mapped to the dedicated channel too
  const unrouted = new Types.ObjectId(); // mapped to nothing
  const docId = new Types.ObjectId();

  /** A stored connection row as `.lean()` hands it back: no schema defaults applied. */
  const row = (channelName: string, over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    orgId,
    teamName: "LNKDRP",
    channelName,
    isDefault: false,
    projectIds: [] as Types.ObjectId[],
    // The shape the live rows really have: four keys, no `docs`.
    events: { views: true, briefs: true, docUpdates: true, requests: true },
    status: "active",
    ...over,
  });

  let catchAll: ReturnType<typeof row>;
  let dedicated: ReturnType<typeof row>;

  const nameOf = (id: unknown) => db.connections.find((c) => String(c._id) === String(id))?.channelName ?? String(id);

  /** Run one event and answer with the ids and the channel names that received a row. */
  async function enqueue(kind: SlackEventKey, event: SlackOutboxEvent, sourceId = `src-${++db.seq}`) {
    db.inserted = [];
    const written = await enqueueSlackPosts({ orgId, kind, sourceId, event, postNow: false });
    // Nothing here may post, and nothing here may fail quietly: `enqueueSlackPosts` turns every
    // throw into a 0, which would otherwise be indistinguishable from "routed nowhere".
    expect(db.posts).toEqual([]);
    expect(db.errors).toEqual([]);
    return {
      written,
      ids: db.inserted.map((r) => String(r.connectionId)).sort(),
      names: db.inserted.map((r) => nameOf(r.connectionId)).sort(),
      rows: db.inserted,
    };
  }

  beforeEach(() => {
    catchAll = row("#sharelinks", { isDefault: true });
    dedicated = row("fundraising-dataroom", { projectIds: [dataRoom, fundraising] });
    db.connections = [catchAll, dedicated];
    db.doc = null;
    db.lockedProjectIds = [];
    db.inserted = [];
    db.dedupeKeys = new Set();
    db.insertOptions = [];
    db.posts = [];
    db.errors = [];
  });

  test("a document in the routed data room reaches the dedicated channel and never the catch-all", async () => {
    db.doc = { projectIds: [dataRoom] };
    const { written, ids, names } = await enqueue("docs", { docId, projectId: dataRoom });
    expect(names).toEqual(["fundraising-dataroom"]);
    expect(ids).toEqual([String(dedicated._id)]);
    expect(ids).not.toContain(String(catchAll._id));
    expect(written).toBe(1);
  });

  test("the row records which channel it is for, and how a repeat of the same event is deduped", async () => {
    db.doc = { projectIds: [dataRoom] };
    const first = await enqueue("docs", { docId, projectId: dataRoom }, "doc-1:room:29000");
    expect(first.rows[0]).toMatchObject({ connectionId: dedicated._id, kind: "docs", status: "pending", attempts: 0 });
    expect(first.rows[0]?.dedupeKey).toBe(`docs:${String(dedicated._id)}:doc-1:room:29000`);
    expect(db.insertOptions).toEqual([{ ordered: false }]);
    // The same source again writes nothing, and the swallowed duplicate is not reported as an error.
    const again = await enqueue("docs", { docId, projectId: dataRoom }, "doc-1:room:29000");
    expect(again.written).toBe(0);
    expect(again.ids).toEqual([]);
  });

  test("a document in no project at all reaches the catch-all only", async () => {
    db.doc = { projectIds: [] };
    const { ids, names } = await enqueue("docs", { docId, projectId: null });
    expect(names).toEqual(["#sharelinks"]);
    expect(ids).toEqual([String(catchAll._id)]);
    expect(ids).not.toContain(String(dedicated._id));
  });

  test("a document in a project that is routed nowhere reaches the catch-all only", async () => {
    db.doc = { projectIds: [unrouted] };
    const { ids, names } = await enqueue("docs", { docId, projectId: unrouted });
    expect(names).toEqual(["#sharelinks"]);
    expect(ids).toEqual([String(catchAll._id)]);
    expect(ids).not.toContain(String(dedicated._id));
  });

  test("a document in a routed room and an unrouted room reaches the dedicated channel only", async () => {
    db.doc = { projectIds: [dataRoom, unrouted] };
    const { ids, names } = await enqueue("docs", { docId, projectId: dataRoom });
    expect(names).toEqual(["fundraising-dataroom"]);
    expect(ids).not.toContain(String(catchAll._id));
  });

  test("a document in two rooms that are routed to different channels reaches both and not the catch-all", async () => {
    const second = row("#board", { projectIds: [unrouted] });
    db.connections = [catchAll, dedicated, second];
    db.doc = { projectIds: [dataRoom, unrouted] };
    const { ids, names } = await enqueue("docs", { docId });
    expect(names).toEqual(["#board", "fundraising-dataroom"]);
    expect(ids.sort()).toEqual([String(dedicated._id), String(second._id)].sort());
    expect(ids).not.toContain(String(catchAll._id));
  });

  test("the same project mapped on two cards posts to both of them, which is why the picker unmaps the other card", async () => {
    // The state the database allows and `PATCH /api/orgs/active/slack` prevents by pulling the
    // project off every other card. If that $pull ever stops running, the room posts twice.
    const twin = row("#duplicate", { projectIds: [dataRoom] });
    db.connections = [catchAll, dedicated, twin];
    db.doc = { projectIds: [dataRoom] };
    const { ids, names, written } = await enqueue("docs", { docId });
    expect(names).toEqual(["#duplicate", "fundraising-dataroom"]);
    expect(written).toBe(2);
    expect(ids).not.toContain(String(catchAll._id));
  });

  test("turning new documents off on the data room's channel makes the room quiet, not louder", async () => {
    // End to end over the stored rows: the owner switches `docs` off on fundraising-dataroom. The
    // data room's documents must stop posting, and must NOT reappear in #sharelinks, which every
    // Slack member reads. Before the fix this wrote one row against the catch-all.
    db.connections = [catchAll, row("fundraising-dataroom", { projectIds: [dataRoom], events: { views: true, briefs: true, docUpdates: true, requests: true, docs: false } })];
    db.doc = { projectIds: [dataRoom] };
    const { written, ids, names } = await enqueue("docs", { docId, projectId: dataRoom });
    expect(names).toEqual([]);
    expect(ids).toEqual([]);
    expect(written).toBe(0);
    // The switch is per kind: the same room's views still reach its own channel.
    db.doc = { projectIds: [dataRoom] };
    expect((await enqueue("views", { docId, projectId: dataRoom })).names).toEqual(["fundraising-dataroom"]);
  });

  test("removing the dedicated channel altogether still sends its room back to the catch-all", async () => {
    // The contrast that keeps the fix honest. A switch turned off is a choice about one channel and
    // must not reroute; a channel that no longer exists leaves the room mapped to nothing, so the
    // catch-all is where the event was always going to land.
    db.connections = [catchAll];
    db.doc = { projectIds: [dataRoom] };
    const { names } = await enqueue("docs", { docId, projectId: dataRoom });
    expect(names).toEqual(["#sharelinks"]);
  });

  test("a switch off on the catch-all, with nothing else routed, enqueues nothing", async () => {
    db.connections = [row("#sharelinks", { isDefault: true, events: { views: true, briefs: true, docUpdates: true, requests: true, docs: false } }), dedicated];
    db.doc = { projectIds: [unrouted] };
    const { written, ids } = await enqueue("docs", { docId });
    expect(written).toBe(0);
    expect(ids).toEqual([]);
  });

  test("a revoked catch-all receives nothing and the event is dropped rather than rerouted", async () => {
    // Correct: a revoked channel is a dead webhook, and an unrouted event has nowhere else it was
    // ever meant to go. It must not be handed to a dedicated channel that was never routed to it.
    db.connections = [row("#sharelinks", { isDefault: true, status: "revoked" }), dedicated];
    db.doc = { projectIds: [unrouted] };
    const { written, ids } = await enqueue("docs", { docId });
    expect(written).toBe(0);
    expect(ids).toEqual([]);
  });

  test("a revoked dedicated channel hands its room's documents to the catch-all", async () => {
    // Recorded behaviour, and defensible rather than plainly right. The catch-all exists so nothing
    // is lost, and a revocation is Slack's doing, not the workspace's, so the alternative is losing
    // the event with no trace. It is still a visibility change nobody chose: a room deliberately
    // given its own channel starts appearing in the channel everyone reads. A contained or locked
    // room is protected from this by `allowDefault: false`; an ordinary room in a dedicated channel
    // is not. Worth a product decision, not a silent fallback.
    db.connections = [catchAll, row("fundraising-dataroom", { projectIds: [dataRoom], status: "revoked" })];
    db.doc = { projectIds: [dataRoom] };
    const { names } = await enqueue("docs", { docId, projectId: dataRoom });
    expect(names).toEqual(["#sharelinks"]);
  });

  test("no default channel exists and the document is unrouted: nothing is enqueued and nothing throws", async () => {
    db.connections = [dedicated]; // no isDefault row anywhere in the workspace
    db.doc = { projectIds: [unrouted] };
    const { written, ids } = await enqueue("docs", { docId });
    expect(written).toBe(0);
    expect(ids).toEqual([]);
    expect(db.errors).toEqual([]);
  });

  test("a workspace with no connections at all enqueues nothing", async () => {
    db.connections = [];
    db.doc = { projectIds: [dataRoom] };
    const { written, ids } = await enqueue("docs", { docId });
    expect(written).toBe(0);
    expect(ids).toEqual([]);
  });

  test("all five event kinds route to the dedicated channel, including docs against a row with no docs key", async () => {
    expect(SLACK_EVENT_KEYS).toEqual(["views", "briefs", "docUpdates", "requests", "docs"]);
    // Neither stored row has a `docs` key, exactly as the live workspace's two rows do not.
    expect((dedicated.events as Record<string, unknown>).docs).toBeUndefined();
    expect((catchAll.events as Record<string, unknown>).docs).toBeUndefined();
    for (const kind of SLACK_EVENT_KEYS) {
      db.doc = { projectIds: [dataRoom] };
      const { names, ids } = await enqueue(kind, { docId, projectId: dataRoom });
      expect(names, kind).toEqual(["fundraising-dataroom"]);
      expect(ids, kind).not.toContain(String(catchAll._id));
    }
  });

  test("all five event kinds reach the catch-all when nothing is routed, including docs", async () => {
    for (const kind of SLACK_EVENT_KEYS) {
      db.doc = { projectIds: [] };
      const { names } = await enqueue(kind, { docId });
      expect(names, kind).toEqual(["#sharelinks"]);
    }
  });

  test("a contained document posts to its room's channel and, when that room has none, nowhere", async () => {
    db.doc = { visibility: "project", primaryProjectId: dataRoom, projectIds: [dataRoom] };
    expect((await enqueue("docs", { docId, projectId: dataRoom })).names).toEqual(["fundraising-dataroom"]);
    db.doc = { visibility: "project", primaryProjectId: unrouted, projectIds: [unrouted] };
    const away = await enqueue("docs", { docId, projectId: unrouted });
    expect(away.written).toBe(0);
    expect(away.ids).toEqual([]);
  });

  test("a locked room never falls back to the catch-all, even alongside an unrouted room", async () => {
    db.lockedProjectIds = [String(unrouted)];
    db.doc = { projectIds: [unrouted] };
    const { written, ids } = await enqueue("docs", { docId });
    expect(written).toBe(0);
    expect(ids).toEqual([]);
  });

  /**
   * The omission that would have made the lock check useless on a real document.
   *
   * `routingFor` used to build its candidate set from `projectIds` alone, but a document's home
   * also lives in `primaryProjectId` and in the backward-compat `projectId` alias the model still
   * carries. A document whose home was set while the array had not caught up was therefore judged
   * against an empty candidate set: the locked room was never looked up, `allowDefault` stayed
   * true, and the private room's documents and readers went to the channel the whole workspace
   * reads. The guard was there and simply never saw the room.
   */
  test("a locked room is found through the home pointer, not only through projectIds", async () => {
    db.lockedProjectIds = [String(unrouted)];
    for (const doc of [{ projectIds: [], primaryProjectId: unrouted }, { projectIds: [], projectId: unrouted }]) {
      db.doc = doc;
      const { written, ids } = await enqueue("docs", { docId });
      expect(written, JSON.stringify(doc)).toBe(0);
      expect(ids, JSON.stringify(doc)).toEqual([]);
    }
  });

  test("an unlocked room reached only through the home pointer still routes to its own channel", async () => {
    // The same omission, in its ordinary clothes: this went to the catch-all before the fix.
    db.doc = { projectIds: [], primaryProjectId: fundraising };
    const { names } = await enqueue("docs", { docId });
    expect(names).toEqual(["fundraising-dataroom"]);
  });

  test("the request inbox a document arrived through routes it, even with no project on the event", async () => {
    db.doc = { projectIds: [], receivedViaRequestProjectId: fundraising };
    const { names, ids } = await enqueue("requests", { docId });
    expect(names).toEqual(["fundraising-dataroom"]);
    expect(ids).not.toContain(String(catchAll._id));
  });
});

/**
 * A post that is claimed and then abandoned must come back.
 *
 * `drainSlackOutbox` claims with `status: "sending"` and every drain selects `status: "pending"`,
 * so before this existed a row whose drain was torn down between the claim and the terminal write
 * was invisible for good: the TTL index only reaps `sent`, nothing counts `sending`, and no admin
 * surface reads the outbox. The channel just never heard, and it looked exactly like a routing bug.
 */
describe("stale claim recovery", () => {
  beforeEach(() => {
    db.updates = [];
    db.modifiedCount = 0;
    db.errors = [];
  });

  test("a row abandoned in sending is handed back to pending, with its claim token dropped", async () => {
    db.modifiedCount = 3;
    const now = new Date("2026-09-26T12:00:00.000Z");
    expect(await recoverStaleSlackClaims({ now })).toBe(3);
    expect(db.updates).toHaveLength(1);
    const { filter, update } = db.updates[0]!;
    expect(filter.status).toBe("sending");
    // Ten minutes, the same staleness the notification queue uses for the same reason.
    expect(CLAIM_STALE_MS).toBe(10 * 60 * 1000);
    expect((filter.claimedAt.$lt as Date).toISOString()).toBe(new Date(now.getTime() - CLAIM_STALE_MS).toISOString());
    // The token goes back with the claim, so the drain that was holding the row owns nothing and a
    // late write from it cannot land on whoever claims the row next.
    expect(update.$set).toEqual({ status: "pending", nextAttemptAt: now, claimedAt: null, claimToken: null });
    // Attempts are not charged: a torn-down runner is not a failed send.
    expect(JSON.stringify(update)).not.toContain("attempts");
    expect(db.errors).toEqual([]);
  });

  test("a row claimed a moment ago is left alone, and the sweep can be scoped to one workspace", async () => {
    const now = new Date("2026-09-26T12:00:00.000Z");
    const orgId = new Types.ObjectId();
    await recoverStaleSlackClaims({ now, staleMs: 60_000, workspaceId: orgId });
    const { filter } = db.updates[0]!;
    expect((filter.claimedAt.$lt as Date).toISOString()).toBe(new Date(now.getTime() - 60_000).toISOString());
    expect(String(filter.orgId)).toBe(String(orgId));
  });

  test("the cron's sweep runs the recovery and reports what it handed back", async () => {
    // The wiring, not just the function: `drainSlackOutbox` with no `rowIds` is the cron and the
    // visit-brief run, the only callers that can see rows another drain abandoned.
    db.modifiedCount = 2;
    const result = await drainSlackOutbox({ now: new Date("2026-09-26T12:00:00.000Z") });
    expect(result.recovered).toBe(2);
    expect(db.updates.map((u) => u.filter.status)).toEqual(["sending"]);
  });

  test("writing an event's rows never runs the sweep: only a drain that can see other runs' rows does", async () => {
    // `enqueueSlackPosts` with `postNow: false` writes and stops. The recovery is a sweep's job, and
    // paying for an extra `updateMany` on every filed document would be a write per event.
    db.connections = [];
    await enqueueSlackPosts({ orgId: new Types.ObjectId(), kind: "docs", sourceId: "s-1", event: {}, postNow: false });
    expect(db.updates).toEqual([]);
  });
});

describe("the burst cap", () => {
  test("thirty a minute, the rest held", () => {
    expect(burstAllowance(0, 40)).toEqual({ allowed: SLACK_BURST_PER_MINUTE, held: 40 - SLACK_BURST_PER_MINUTE });
    expect(burstAllowance(25, 10)).toEqual({ allowed: 5, held: 5 });
    expect(burstAllowance(30, 3)).toEqual({ allowed: 0, held: 3 });
    expect(burstAllowance(0, 3)).toEqual({ allowed: 3, held: 0 });
    expect(burstAllowance(-1, -1)).toEqual({ allowed: 0, held: 0 });
  });

  test("the channel is told once how many are waiting", () => {
    const m = slackBurstMessage({ held: 10, cap: 30 });
    expect(m.text).toContain("10 more");
    expect(m.text).toContain("30 a minute");
    expect(m.blocks).toHaveLength(1);
  });
});

describe("one project, one channel (source contract)", () => {
  test("mapping a project on one card pulls it from every other card in the workspace", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/orgs/active/slack/route.ts", "utf8");
    expect(src).toMatch(/\$pull: \{ projectIds: \{ \$in: set\.projectIds \} \}/);
    expect(src).toMatch(/_id: \{ \$ne: connectionId \} \}, \{ \$pull/);
  });

  test("the picker offers a project already routed elsewhere with that channel's name", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(app)/integrations/slack/pageClient.tsx", "utf8");
    expect(src).toContain("now on ${other}");
    expect(src).toContain("/api/requests");
  });
});
