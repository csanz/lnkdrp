/**
 * The notification queue's write path (`src/lib/notifications/queue.ts`,
 * docs/prds/lnkdrp-notification-queue.md).
 *
 * These run against a small in-memory stand-in for the collection rather than a real Mongo,
 * because every property that matters here lives in a filter and a filter is the one thing a
 * recorder mock cannot check: the claim is a lock only because `{status: "pending"}` is part of it,
 * a mark is safe only because it names the claim token it was handed, and a dry run is side-effect
 * free only because it never issues an update at all.
 *
 * Pinned rather than left to review because the failure mode is silent and expensive in both
 * directions: a claim that is not atomic sends the same email twice, and a retry that is not
 * bounded means a broken address is retried forever while nobody can see that it is broken. The
 * model this replaces failed exactly that way for months with no error anywhere.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

type Row = Record<string, any>;

/** The collection. Every mocked method reads and writes this array and nothing else. */
let store: Row[] = [];

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Types.ObjectId || b instanceof Types.ObjectId) return String(a) === String(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function at(row: Row, path: string): unknown {
  return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), row);
}

function isOperatorClause(clause: unknown): boolean {
  return (
    Boolean(clause) &&
    typeof clause === "object" &&
    !Array.isArray(clause) &&
    !(clause instanceof Date) &&
    !(clause instanceof Types.ObjectId) &&
    Object.keys(clause as object).every((k) => k.startsWith("$"))
  );
}

function matchesClause(value: any, clause: any): boolean {
  if (!isOperatorClause(clause)) return same(clause, value);
  return Object.entries(clause).every(([op, operand]) => {
    switch (op) {
      case "$in":
        return (operand as unknown[]).some((v) => same(v, value));
      case "$nin":
        return !(operand as unknown[]).some((v) => same(v, value));
      case "$ne":
        return !same(operand, value);
      case "$lt":
        return value != null && (value as any) < (operand as any);
      case "$lte":
        return value != null && (value as any) <= (operand as any);
      case "$gt":
        return value != null && (value as any) > (operand as any);
      case "$gte":
        return value != null && (value as any) >= (operand as any);
      default:
        throw new Error(`unsupported operator in test double: ${op}`);
    }
  });
}

function matching(filter: Row): Row[] {
  return store.filter((row) => Object.entries(filter).every(([key, clause]) => matchesClause(at(row, key), clause)));
}

function sorted(rows: Row[], sort: Record<string, 1 | -1> | undefined): Row[] {
  if (!sort) return rows;
  const keys = Object.entries(sort);
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const av = at(a, key) as any;
      const bv = at(b, key) as any;
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

/** A chainable query whose `lean()` resolves the rows the filter and the chain select. */
function query(filter: Row) {
  let sort: Record<string, 1 | -1> | undefined;
  let limit = Number.POSITIVE_INFINITY;
  const q: any = {
    sort: (s: Record<string, 1 | -1>) => {
      sort = s;
      return q;
    },
    limit: (n: number) => {
      limit = n;
      return q;
    },
    select: () => q,
    lean: async () => sorted(matching(filter), sort).slice(0, limit).map((r) => ({ ...r })),
  };
  return q;
}

const create = vi.fn(async (doc: Row) => {
  if (store.some((r) => r.dedupeKey === doc.dedupeKey)) {
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }
  const row = { _id: new Types.ObjectId(), ...doc };
  store.push(row);
  return row;
});

const find = vi.fn((filter: Row = {}) => query(filter));

const findOne = vi.fn((filter: Row = {}) => {
  let sort: Record<string, 1 | -1> | undefined;
  const q: any = {
    sort: (s: Record<string, 1 | -1>) => {
      sort = s;
      return q;
    },
    select: () => q,
    lean: async () => {
      const row = sorted(matching(filter), sort)[0];
      return row ? { ...row } : null;
    },
  };
  return q;
});

const updateMany = vi.fn(async (filter: Row, update: Row) => {
  const rows = matching(filter);
  for (const row of rows) Object.assign(row, update.$set ?? {});
  return { modifiedCount: rows.length };
});

const countDocuments = vi.fn(async (filter: Row = {}) => matching(filter).length);

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/NotificationQueue", () => ({
  NotificationQueueModel: { create, updateMany, find, findOne, countDocuments },
  NOTIFICATION_QUEUE_STATUSES: ["pending", "sending", "sent", "skipped", "dead"],
  NOTIFICATION_QUEUE_KINDS: ["share_views", "doc_updates", "repo_link_requests"],
}));

const {
  BACKOFF_MS,
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  MAX_CLAIM_BATCH,
  claimBatch,
  claimTokenOf,
  enqueueNotification,
  markFailed,
  markSent,
  markSkipped,
  notificationDedupeKey,
  queueDepth,
  recoverStaleClaims,
  releaseClaims,
  sentNotificationsForViewer,
  skipPending,
  wasNotified,
} = await import("@/lib/notifications/queue");

const ORG_ID = new Types.ObjectId();
const USER_ID = new Types.ObjectId();
const NOW = new Date("2026-09-19T12:00:00.000Z");

function pendingRow(overrides: Partial<Row> = {}): Row {
  return {
    _id: new Types.ObjectId(),
    orgId: ORG_ID,
    userId: USER_ID,
    kind: "share_views",
    dedupeKey: `share_views:${USER_ID}:${new Types.ObjectId()}`,
    event: {},
    occurredAt: new Date(NOW.getTime() - 60_000),
    attempts: 0,
    status: "pending",
    nextAttemptAt: new Date(NOW.getTime() - 60_000),
    claimedAt: null,
    claimToken: null,
    sentAt: null,
    ...overrides,
  };
}

/** Seed the collection and hand back the rows, so a test can name them. */
function seed(...rows: Row[]): Row[] {
  store.push(...rows);
  return rows;
}

/** The `[filter, update]` pair of the nth `updateMany`. */
function wrote(n = 0): [Row, Row] {
  return updateMany.mock.calls[n]! as [Row, Row];
}

/** The row as it is now, by id. */
function reread(row: Row): Row {
  return store.find((r) => String(r._id) === String(row._id))!;
}

beforeEach(() => {
  store = [];
  vi.clearAllMocks();
});

describe("enqueueNotification", () => {
  test("writes down one email owed, pending and due now", async () => {
    const occurredAt = new Date(NOW.getTime() - 5_000);
    const res = await enqueueNotification({
      orgId: ORG_ID,
      userId: USER_ID,
      kind: "share_views",
      dedupeKey: "share_views:u:v",
      event: { shareId: "the-link", viewerName: "  Michael Jay  ", viewerEmail: "Michael@Example.com" },
      occurredAt,
    });

    expect(res).toEqual({ enqueued: true, duplicate: false });
    const doc = create.mock.calls[0]![0] as Row;
    expect(doc.status).toBe("pending");
    expect(doc.attempts).toBe(0);
    expect(doc.occurredAt).toBe(occurredAt);
    expect(doc.sentAt).toBeNull();
    // Normalized on the way in, so the sender renders what it is given without re-trimming.
    expect(doc.event.viewerName).toBe("Michael Jay");
    expect(doc.event.viewerEmail).toBe("michael@example.com");
    expect(doc.event.shareId).toBe("the-link");
  });

  /**
   * Decision 9: the row stores the PERSON. A project link writes `<digest>.<docId>` into its
   * analytics rows, and three bugs this month came from those two shapes being compared literally
   * — so the split happens here rather than resting on every call site remembering it.
   */
  test("a project link's composite viewer key is stored as the bare digest", async () => {
    await enqueueNotification({
      orgId: ORG_ID,
      userId: USER_ID,
      kind: "share_views",
      dedupeKey: "share_views:u:v1",
      event: { viewerKey: `deadbeef.${new Types.ObjectId()}` },
    });
    expect((create.mock.calls[0]![0] as Row).event.viewerKey).toBe("deadbeef");
  });

  test("a duplicate dedupeKey is swallowed: already owed is not an error", async () => {
    seed(pendingRow({ dedupeKey: "doc_updates:u:x" }));
    expect(
      await enqueueNotification({ orgId: ORG_ID, userId: USER_ID, kind: "doc_updates", dedupeKey: "doc_updates:u:x" }),
    ).toEqual({ enqueued: false, duplicate: true });
  });

  test("any other failure is swallowed too: a notification never breaks its caller", async () => {
    create.mockRejectedValueOnce(new Error("mongo is having a moment"));
    expect(
      await enqueueNotification({ orgId: ORG_ID, userId: USER_ID, kind: "doc_updates", dedupeKey: "doc_updates:u:y" }),
    ).toEqual({ enqueued: false, duplicate: false });
  });

  test("an unusable row is never written", async () => {
    expect(
      await enqueueNotification({ orgId: "not-an-id", userId: USER_ID, kind: "share_views", dedupeKey: "k" }),
    ).toEqual({ enqueued: false, duplicate: false });
    expect(await enqueueNotification({ orgId: ORG_ID, userId: USER_ID, kind: "share_views", dedupeKey: "  " })).toEqual({
      enqueued: false,
      duplicate: false,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("the dedupe key is the event's own identity, not a timestamp", () => {
    const viewId = new Types.ObjectId();
    expect(notificationDedupeKey("share_views", USER_ID, viewId)).toBe(`share_views:${USER_ID}:${viewId}`);
  });
});

describe("claimBatch", () => {
  test("claims with the filter as the lock: pending, due, flipped to sending with a token", async () => {
    const [row] = seed(pendingRow());

    const claimed = await claimBatch({ limit: 10, now: NOW });

    expect(claimed).toHaveLength(1);
    expect(reread(row!).status).toBe("sending");
    expect(reread(row!).claimedAt).toEqual(NOW);
    expect(claimed[0]!.claimToken).toBe(reread(row!).claimToken);
    expect(claimed[0]!.claimToken).toBeTruthy();
    const [filter] = wrote();
    expect(filter.status).toBe("pending");
    expect(filter.nextAttemptAt).toEqual({ $lte: NOW });
  });

  /** The failure this prevents is the one nobody reports: the same email arriving twice. */
  test("cannot hand one row to two runners", async () => {
    const [row] = seed(pendingRow());

    const [a, b] = await Promise.all([claimBatch({ limit: 5, now: NOW }), claimBatch({ limit: 5, now: NOW })]);

    expect(a.length + b.length).toBe(1);
    expect(reread(row!).status).toBe("sending");
    // And the winner is identifiable: the token on the row is the one that runner was handed.
    expect([...a, ...b][0]!.claimToken).toBe(reread(row!).claimToken);
  });

  test("a whole batch costs a fixed number of round trips, not one per row", async () => {
    seed(...Array.from({ length: 40 }, () => pendingRow()));

    const claimed = await claimBatch({ limit: 40, now: NOW });

    expect(claimed).toHaveLength(40);
    // Read the candidates, take them, read back what was won. A per-row `findOneAndUpdate` made a
    // 500-row digest 500 serialised round trips inside a cron tick with a 300s wall clock.
    expect(find).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  test("a row that is not due yet stays where it is", async () => {
    seed(pendingRow({ nextAttemptAt: new Date(NOW.getTime() + 60_000) }));
    expect(await claimBatch({ limit: 5, now: NOW })).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  test("the batch is bounded however much the caller asks for", async () => {
    seed(...Array.from({ length: MAX_CLAIM_BATCH + 10 }, () => pendingRow()));
    expect(await claimBatch({ limit: 10_000, now: NOW })).toHaveLength(MAX_CLAIM_BATCH);
  });

  test("scopes to one workspace, member and kind when asked", async () => {
    seed(pendingRow({ kind: "doc_updates" }), pendingRow({ kind: "share_views" }));
    const claimed = await claimBatch({ limit: 5, now: NOW, orgId: ORG_ID, userId: USER_ID, kind: "doc_updates" });
    expect(claimed.map((r) => r.kind)).toEqual(["doc_updates"]);
  });

  /**
   * `--dry-run` is the default for the CLI and it is what made the investigation that produced this
   * PRD safe to run against production. A dry run that claimed rows would leave them `sending` with
   * nobody sending them.
   */
  test("a dry run can never claim", async () => {
    const [row] = seed(pendingRow());

    const rows = await claimBatch({ limit: 10, now: NOW, dryRun: true });

    expect(rows).toHaveLength(1);
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(reread(row!).status).toBe("pending");
    // And it reports what the next real tick would take: same filter, same order.
    expect(find.mock.calls[0]![0]).toMatchObject({ status: "pending", nextAttemptAt: { $lte: NOW } });
  });
});

describe("markSent", () => {
  test("marks a whole digest sent in one update", async () => {
    const rows = seed(pendingRow(), pendingRow());
    const claimed = await claimBatch({ limit: 5, now: NOW });

    expect(await markSent({ ids: claimed.map((r) => r.id), claimToken: claimTokenOf(claimed), now: NOW })).toBe(2);
    for (const row of rows) {
      expect(reread(row).status).toBe("sent");
      expect(reread(row).sentAt).toEqual(NOW);
      expect(reread(row).claimToken).toBeNull();
    }
  });

  /**
   * The double-send this closes: a stalled runner wakes up after the stale sweep handed its row
   * back and somebody else re-claimed and sent it. `status: "sending"` is true again by then, and
   * `attempts` is unchanged because recovery deliberately does not spend one — so the token is the
   * only thing that can tell the two claims apart.
   */
  test("a stalled runner cannot write its outcome over a re-claim", async () => {
    const [row] = seed(pendingRow());
    const stalled = await claimBatch({ limit: 1, now: NOW });
    await recoverStaleClaims({ now: new Date(NOW.getTime() + CLAIM_STALE_MS + 1_000) });
    const reclaimed = await claimBatch({ limit: 1, now: new Date(NOW.getTime() + CLAIM_STALE_MS + 1_000) });

    expect(await markSent({ ids: stalled.map((r) => r.id), claimToken: claimTokenOf(stalled), now: NOW })).toBe(0);
    expect(reread(row!).status).toBe("sending");

    expect(await markSent({ ids: reclaimed.map((r) => r.id), claimToken: claimTokenOf(reclaimed), now: NOW })).toBe(1);
    expect(reread(row!).status).toBe("sent");
  });

  test("no ids, no write", async () => {
    expect(await markSent({ ids: [] })).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("releaseClaims", () => {
  /**
   * A view digest renders at most `DIGEST_MAX_DOCUMENTS` documents; rows past that were in no
   * email at all. Marked `sent` they would make `wasNotified()` answer "yes, they were told" about
   * documents nobody was told about, so they come back unsent — and unpenalised.
   */
  test("hands rows back pending and due, with no attempt spent and no error", async () => {
    const [row] = seed(pendingRow({ attempts: 2 }));
    const claimed = await claimBatch({ limit: 1, now: NOW });
    const later = new Date(NOW.getTime() + 1_000);

    expect(await releaseClaims({ ids: claimed.map((r) => r.id), claimToken: claimTokenOf(claimed), now: later })).toBe(1);

    const after = reread(row!);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(2);
    expect(after.nextAttemptAt).toEqual(later);
    expect(after.claimToken).toBeNull();
    expect(after.sentAt).toBeNull();
  });
});

describe("markFailed", () => {
  test("the first failure waits a minute and goes back to pending", async () => {
    const [row] = seed(pendingRow());
    const claimed = await claimBatch({ limit: 1, now: NOW });

    await markFailed({
      rows: claimed.map((r) => ({ id: r.id, attempts: r.attempts })),
      claimToken: claimTokenOf(claimed),
      error: new Error("smtp said no"),
      now: NOW,
    });

    const after = reread(row!);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(1);
    expect(after.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(after.lastError).toBe("smtp said no");
    expect(after.claimedAt).toBeNull();
  });

  test("backoff advances 1m, 5m, 30m, 2h as attempts pile up", async () => {
    const expected = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
    for (let attempts = 0; attempts < expected.length; attempts += 1) {
      updateMany.mockClear();
      await markFailed({ rows: [{ id: new Types.ObjectId(), attempts }], error: "nope", now: NOW });
      const update = wrote()[1];
      expect(update.$set.status).toBe("pending");
      expect(update.$set.attempts).toBe(attempts + 1);
      expect(update.$set.nextAttemptAt).toEqual(new Date(NOW.getTime() + expected[attempts]!));
    }
    // The schedule's last step exists for a raised MAX_ATTEMPTS; today the 5th failure is dead.
    expect(BACKOFF_MS[BACKOFF_MS.length - 1]).toBe(12 * 60 * 60_000);
  });

  test("the fifth failure is dead, not pending, and keeps the reason", async () => {
    const [row] = seed(pendingRow({ attempts: MAX_ATTEMPTS - 1 }));
    const claimed = await claimBatch({ limit: 1, now: NOW });

    const res = await markFailed({
      rows: claimed.map((r) => ({ id: r.id, attempts: r.attempts })),
      claimToken: claimTokenOf(claimed),
      error: new Error("mailbox does not exist"),
      now: NOW,
    });

    expect(reread(row!).status).toBe("dead");
    expect(reread(row!).attempts).toBe(MAX_ATTEMPTS);
    expect(reread(row!).lastError).toBe("mailbox does not exist");
    expect(res).toEqual({ retried: 0, dead: 1 });
  });

  test("a failed digest is grouped by attempt count, not one update per row", async () => {
    await markFailed({
      rows: [
        { id: new Types.ObjectId(), attempts: 0 },
        { id: new Types.ObjectId(), attempts: 0 },
        { id: new Types.ObjectId(), attempts: 2 },
      ],
      error: "resend timed out",
      now: NOW,
    });

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(wrote(0)[0]._id.$in).toHaveLength(2);
    expect(wrote(1)[0]).toMatchObject({ attempts: 2 });
  });

  test("a stalled runner's failure cannot age a re-claimed row", async () => {
    const [row] = seed(pendingRow());
    const stalled = await claimBatch({ limit: 1, now: NOW });
    const later = new Date(NOW.getTime() + CLAIM_STALE_MS + 1_000);
    await recoverStaleClaims({ now: later });
    await claimBatch({ limit: 1, now: later });

    const res = await markFailed({
      rows: stalled.map((r) => ({ id: r.id, attempts: r.attempts })),
      claimToken: claimTokenOf(stalled),
      error: "late",
      now: later,
    });

    expect(res).toEqual({ retried: 0, dead: 0 });
    expect(reread(row!).status).toBe("sending");
    expect(reread(row!).attempts).toBe(0);
  });
});

describe("markSkipped", () => {
  /** Decision 2: a member who turns notifications off loses the mail, not the record of it. */
  test("skips a backlog that was never claimed, with the reason kept", async () => {
    const [row] = seed(pendingRow());
    await markSkipped({ ids: [row!._id], reason: "member off" });

    const [filter, update] = wrote();
    expect(filter.status).toEqual({ $in: ["pending", "sending"] });
    expect(update.$set).toMatchObject({ status: "skipped", skippedReason: "member off", claimedAt: null });
    expect(reread(row!).status).toBe("skipped");
  });

  test("no ids, no write", async () => {
    expect(await markSkipped({ ids: [], reason: "member off" })).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("skipPending", () => {
  /**
   * The `off` member's backlog: one update, no claim. Claiming first bought nothing — this branch
   * never sends — and cost a round trip per row, every tick, for mail that is never going out.
   */
  test("skips a whole due backlog in one update without claiming it", async () => {
    const rows = seed(pendingRow(), pendingRow(), pendingRow({ nextAttemptAt: new Date(NOW.getTime() + 60_000) }));

    expect(await skipPending({ orgId: ORG_ID, userId: USER_ID, kind: "share_views", reason: "member off", now: NOW })).toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(reread(rows[0]!).skippedReason).toBe("member off");
    // A row that is not due yet is not this tick's decision.
    expect(reread(rows[2]!).status).toBe("pending");
  });

  test("a row another runner already claimed is left to that runner", async () => {
    const [row] = seed(pendingRow());
    await claimBatch({ limit: 1, now: NOW });

    expect(await skipPending({ orgId: ORG_ID, userId: USER_ID, kind: "share_views", reason: "member off", now: NOW })).toBe(0);
    expect(reread(row!).status).toBe("sending");
  });
});

describe("recoverStaleClaims", () => {
  /** A process that dies mid-send leaves a row `sending` forever; that is a lost email with a state. */
  test("hands back rows whose runner died, without spending an attempt", async () => {
    await recoverStaleClaims({ now: NOW });

    const [filter, update] = wrote();
    expect(filter.status).toBe("sending");
    expect(filter.claimedAt).toEqual({ $lt: new Date(NOW.getTime() - CLAIM_STALE_MS) });
    expect(update.$set).toEqual({ status: "pending", nextAttemptAt: NOW, claimedAt: null, claimToken: null });
    // A crash is not evidence that this row is the poison one, so `attempts` is untouched.
    expect(update.$set.attempts).toBeUndefined();
  });

  test("a fresh claim is left alone", async () => {
    await recoverStaleClaims({ now: NOW, staleMs: 60_000 });
    expect(wrote()[0].claimedAt).toEqual({ $lt: new Date(NOW.getTime() - 60_000) });
  });
});

describe("wasNotified", () => {
  test("about one event, the answer is exact", async () => {
    seed(pendingRow({ dedupeKey: "share_views:u:v", status: "sent" }));
    expect(await wasNotified({ dedupeKey: "share_views:u:v" })).toBe(true);
  });

  test("a queued or dead row means they have not been told", async () => {
    seed(pendingRow({ dedupeKey: "share_views:u:v", status: "dead" }));
    expect(await wasNotified({ dedupeKey: "share_views:u:v" })).toBe(false);
    expect(await wasNotified({ dedupeKey: "share_views:u:nothing" })).toBe(false);
  });

  test("over a window it asks for a send, not a high-water mark", async () => {
    seed(pendingRow({ status: "sent", occurredAt: new Date(NOW.getTime() - 60_000) }));
    expect(await wasNotified({ orgId: ORG_ID, userId: USER_ID, kind: "share_views", before: NOW })).toBe(true);
    expect(
      await wasNotified({
        orgId: ORG_ID,
        userId: USER_ID,
        kind: "share_views",
        before: new Date(NOW.getTime() - 120_000),
      }),
    ).toBe(false);
  });
});

describe("sentNotificationsForViewer", () => {
  const OTHER_USER = new Types.ObjectId();

  /**
   * Decision 9: which members were actually told about *this reader*. The correction email's whole
   * premise is a wrong mail sitting in an inbox, so only `sent` counts.
   */
  test("names the members a send actually reached, and when", async () => {
    const earlier = new Date(NOW.getTime() - 60_000);
    seed(
      pendingRow({ status: "sent", sentAt: earlier, event: { viewerKey: "reader" } }),
      pendingRow({ status: "sent", sentAt: NOW, event: { viewerKey: "reader" } }),
      pendingRow({ status: "pending", userId: OTHER_USER, event: { viewerKey: "reader" } }),
    );

    const told = await sentNotificationsForViewer({ orgId: ORG_ID, viewerKey: "reader" });

    // One entry per member, carrying their most recent send — a reader who opened four documents
    // is four rows, and the question is about the person.
    expect(told).toEqual([{ userId: String(USER_ID), sentAt: NOW }]);
  });

  test("a project link's composite key finds the same reader", async () => {
    seed(pendingRow({ status: "sent", sentAt: NOW, event: { viewerKey: "reader" } }));
    const told = await sentNotificationsForViewer({ orgId: ORG_ID, viewerKey: `reader.${new Types.ObjectId()}` });
    expect(told.map((t) => t.userId)).toEqual([String(USER_ID)]);
  });

  test("nothing sent, nobody to correct", async () => {
    seed(pendingRow({ status: "skipped", event: { viewerKey: "reader" } }));
    expect(await sentNotificationsForViewer({ orgId: ORG_ID, viewerKey: "reader" })).toEqual([]);
    expect(await sentNotificationsForViewer({ orgId: ORG_ID, viewerKey: "   " })).toEqual([]);
  });
});

describe("queueDepth", () => {
  test("says what is waiting, what went out and what gave up", async () => {
    const oldest = new Date(NOW.getTime() - 3 * 60 * 60_000);
    seed(
      pendingRow({ occurredAt: oldest }),
      pendingRow(),
      pendingRow({ nextAttemptAt: new Date(NOW.getTime() + 60_000) }),
      pendingRow({ status: "sent" }),
      pendingRow({ status: "dead" }),
    );

    expect(await queueDepth({ orgId: ORG_ID, now: NOW })).toEqual({
      pending: 3,
      sending: 0,
      sent: 1,
      skipped: 0,
      dead: 1,
      total: 5,
      due: 2,
      oldestPendingAt: oldest,
    });
    // Counts on indexed fields, not a `$group` over every row: this runs on every load of
    // /a/emails and /a/cron-health, against 30 days of `sent` rows fanned out per member.
    expect(countDocuments).toHaveBeenCalled();
  });

  test("an empty queue is zeroes, not an empty object", async () => {
    expect(await queueDepth()).toMatchObject({ pending: 0, dead: 0, total: 0, oldestPendingAt: null });
  });
});
