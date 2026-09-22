/**
 * The notification queue's reader (`src/lib/notifications/sendNotificationEmails.ts`,
 * docs/prds/lnkdrp-notification-queue.md M3).
 *
 * The queue's own primitives are pinned in `notificationQueue.test.ts`; these tests are about the
 * decisions the sender makes around them, which is where the cursor model kept losing mail:
 *
 * - what it claims, and what it deliberately does NOT claim (a digest before its tick, a hidden
 *   feature, a member on `off`) — a row claimed and then not sent is a row nobody can see;
 * - that a dry run writes nothing at all, claims included, because that is the property that makes
 *   pointing the CLI at production safe;
 * - that one failed message puts only its own rows on the backoff schedule and leaves every other
 *   message in the round alone, which is the whole reason the queue exists;
 * - that the bodies and subjects are the ones the product already sends.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/** A Mongoose query stand-in: chainable, resolves `rows` from `.lean()`. */
function chain(rows: unknown[]) {
  const q = {
    sort: () => q,
    limit: () => q,
    select: () => q,
    lean: async () => rows,
  };
  return q;
}

const {
  aggregate,
  queueFindOne,
  queueCount,
  claimBatch,
  releaseClaims,
  skipPending,
  markSent,
  markFailed,
  markSkipped,
  recoverStaleClaims,
  membershipFind,
  userFind,
  shareViewFind,
  shareLinkFind,
  docFind,
  docChangeFind,
  uploadFind,
  projectFind,
  sendTextEmail,
  getWorkspacePlan,
} = vi.hoisted(() => ({
  aggregate: vi.fn(),
  queueFindOne: vi.fn(),
  queueCount: vi.fn(async (..._args: unknown[]) => 0),
  claimBatch: vi.fn(),
  releaseClaims: vi.fn(async (..._args: unknown[]) => 0),
  skipPending: vi.fn(async (..._args: unknown[]) => 0),
  markSent: vi.fn(async (..._args: unknown[]) => 0),
  markFailed: vi.fn(async (..._args: unknown[]) => ({ retried: 0, dead: 0 })),
  markSkipped: vi.fn(async (..._args: unknown[]) => 0),
  recoverStaleClaims: vi.fn(async (..._args: unknown[]) => 0),
  membershipFind: vi.fn(),
  userFind: vi.fn(),
  shareViewFind: vi.fn(),
  shareLinkFind: vi.fn(),
  docFind: vi.fn(),
  docChangeFind: vi.fn(),
  uploadFind: vi.fn(),
  projectFind: vi.fn(),
  sendTextEmail: vi.fn(async (..._args: unknown[]) => undefined),
  getWorkspacePlan: vi.fn(async (): Promise<string> => "free"),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/NotificationQueue", () => ({
  NotificationQueueModel: { aggregate, findOne: queueFindOne, countDocuments: queueCount },
  NOTIFICATION_QUEUE_KINDS: ["share_views", "doc_updates", "repo_link_requests"],
}));
// The queue's write path is tested against its own filters elsewhere; here it is a recorder, so a
// test can assert what the sender asked it to do rather than how Mongo would have done it.
vi.mock("@/lib/notifications/queue", () => ({
  MAX_ATTEMPTS: 5,
  MAX_CLAIM_BATCH: 500,
  claimBatch,
  claimTokenOf: (rows: Array<{ claimToken?: string | null }>) => rows[0]?.claimToken ?? null,
  markSent,
  markFailed,
  markSkipped,
  releaseClaims,
  recoverStaleClaims,
  skipPending,
}));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { find: membershipFind } }));
// The workspace named in every view email's header. Unmocked, `findById` reaches for a real
// connection and every test in this file times out rather than failing with something readable.
vi.mock("@/lib/models/Org", () => ({
  OrgModel: {
    findById: () => ({ select: () => ({ lean: async () => ({ name: "Acme", avatarUrl: null }) }) }),
  },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: userFind } }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { find: shareViewFind } }));
vi.mock("@/lib/models/ShareVisit", () => ({ ShareVisitModel: { find: vi.fn(), aggregate: vi.fn(async () => []) } }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: { find: shareLinkFind } }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { find: docFind } }));
vi.mock("@/lib/models/DocChange", () => ({ DocChangeModel: { find: docChangeFind } }));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { find: uploadFind } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { find: projectFind } }));
vi.mock("@/lib/models/NotificationEmailCursor", () => ({ NotificationEmailCursorModel: { find: vi.fn() } }));
vi.mock("@/lib/email/sendTextEmail", () => ({ sendTextEmail }));
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn(), debugWarn: vi.fn() }));

const { sendNotificationEmails } = await import("@/lib/notifications/sendNotificationEmails");
const { verifyAnyEmailsOffToken } = await import("@/lib/notifications/viewEmailToken");
const { DIGEST_MAX_DOCUMENTS } = await import("@/lib/notifications/viewNotifications");
const { verifyViewEmailsOffToken } = await import("@/lib/notifications/viewEmailToken");

type Kind = "share_views" | "doc_updates" | "repo_link_requests";

type QueueRow = {
  id: string;
  orgId: string;
  userId: string;
  kind: Kind;
  dedupeKey: string;
  event: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
};

const NOW = new Date("2026-09-16T12:00:00.000Z");
const ORG = new Types.ObjectId();
const USER = new Types.ObjectId();
const MEMBERSHIP = new Types.ObjectId();
const DOC_A = new Types.ObjectId();
const DOC_B = new Types.ObjectId();

/** Rows the fake `claimBatch` hands out, and the fake aggregate groups. */
let pending: QueueRow[] = [];

function queueRow(kind: Kind, sourceId: Types.ObjectId, overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: new Types.ObjectId().toString(),
    orgId: String(ORG),
    userId: String(USER),
    kind,
    dedupeKey: `${kind}:${String(USER)}:${String(sourceId)}`,
    event: {},
    occurredAt: new Date(NOW.getTime() - 10 * 60_000),
    attempts: 0,
    ...overrides,
  };
}

/** A `ShareView` row the view email is rendered from. */
function shareViewRow(id: Types.ObjectId, docId: Types.ObjectId) {
  return {
    _id: id,
    orgId: ORG,
    shareId: "shareA",
    docId,
    botIdHash: "reader",
    createdDate: new Date(NOW.getTime() - 10 * 60_000),
    pagesSeen: [1, 2],
    timeSpentMs: 65_000,
  };
}

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: MEMBERSHIP,
    orgId: ORG,
    userId: USER,
    docUpdateEmailMode: "off",
    repoLinkRequestEmailMode: "off",
    viewEmailMode: "off",
    ...overrides,
  };
}

function setMembership(overrides: Record<string, unknown> = {}) {
  membershipFind.mockReturnValue(chain([membershipRow(overrides)]));
}

/** The `$match` and `$limit` of the due-groups pipeline, applied to `pending`. */
function groupPending(pipeline: any[]) {
  const match = pipeline[0]?.$match ?? {};
  const limit = Number(pipeline[3]?.$limit) || Number.POSITIVE_INFINITY;
  const kinds: string[] | null = Array.isArray(match.kind?.$in) ? match.kind.$in : null;
  const rows = pending.filter(
    (r) =>
      (!match.orgId || String(match.orgId) === r.orgId) &&
      (!match.userId || String(match.userId) === r.userId) &&
      (!kinds || kinds.includes(r.kind)),
  );
  const groups = new Map<string, { _id: any; due: number; oldestOccurredAt: Date }>();
  for (const r of rows) {
    const key = `${r.orgId}:${r.userId}:${r.kind}`;
    const g = groups.get(key);
    if (g) {
      g.due += 1;
      if (r.occurredAt < g.oldestOccurredAt) g.oldestOccurredAt = r.occurredAt;
    } else {
      groups.set(key, {
        _id: { orgId: new Types.ObjectId(r.orgId), userId: new Types.ObjectId(r.userId), kind: r.kind },
        due: 1,
        oldestOccurredAt: r.occurredAt,
      });
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => a.oldestOccurredAt.getTime() - b.oldestOccurredAt.getTime())
    .slice(0, limit);
}

/** Every `to`/`subject`/`text` the transport was handed. */
function sent(): Array<{ to: string; subject: string; text: string; html?: string; headers?: Record<string, string> }> {
  return sendTextEmail.mock.calls.map((c) => (c as unknown[])[0] as any);
}

/** Ids passed to `markSent`, flattened across calls. */
function sentIds(): string[] {
  return markSent.mock.calls.flatMap((c) => ((c as unknown[])[0] as { ids: string[] }).ids);
}

/** What `digestAllowedNow` finds: the last digest sent today, and whether anything is left over. */
let lastDigestSentAt: Date | null = null;
let leftOverFromLastDigest = false;

beforeEach(() => {
  vi.clearAllMocks();
  pending = [];
  lastDigestSentAt = null;
  leftOverFromLastDigest = false;
  aggregate.mockImplementation(async (pipeline: any[]) => groupPending(pipeline));
  // `digestAllowedNow` asks two questions of the queue: has a digest gone out since midnight UTC,
  // and is there anything pending from before it (a truncated digest, which may send again today).
  queueFindOne.mockImplementation((filter: any) => {
    const row =
      filter?.status === "sent"
        ? lastDigestSentAt
          ? { sentAt: lastDigestSentAt }
          : null
        : leftOverFromLastDigest
          ? { _id: new Types.ObjectId() }
          : null;
    const q: any = { sort: () => q, select: () => q, lean: async () => row };
    return q;
  });
  queueCount.mockImplementation(async (filter: any) => {
    const kinds: string[] = filter?.kind?.$in ?? [];
    return pending.filter((r) => kinds.includes(r.kind)).length;
  });
  claimBatch.mockImplementation(async (p: any) => {
    const rows = pending.filter((r) => r.orgId === String(p.orgId) && r.userId === String(p.userId) && r.kind === p.kind);
    return rows.slice(0, p.limit);
  });
  recoverStaleClaims.mockResolvedValue(0);
  setMembership();
  userFind.mockReturnValue(chain([{ _id: USER, email: "member@example.com" }]));
  shareViewFind.mockReturnValue(chain([]));
  shareLinkFind.mockReturnValue(
    chain([{ _id: new Types.ObjectId(), shareId: "shareA", label: "Sequoia", audience: null, isDefault: false, createdDate: new Date("2026-01-01") }]),
  );
  docFind.mockReturnValue(chain([]));
  docChangeFind.mockReturnValue(chain([]));
  uploadFind.mockReturnValue(chain([]));
  projectFind.mockReturnValue(chain([]));
  getWorkspacePlan.mockResolvedValue("free");
  sendTextEmail.mockResolvedValue(undefined);
});

describe("what the tick claims", () => {
  test("nothing due is a no-op run", async () => {
    const res = await sendNotificationEmails({ now: NOW });
    expect(claimBatch).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(res.membersProcessed).toBe(0);
    expect(res.workspacesProcessed).toBe(0);
  });

  test("stale claims are handed back before anything is claimed", async () => {
    recoverStaleClaims.mockResolvedValue(3);
    const res = await sendNotificationEmails({ now: NOW });
    expect(recoverStaleClaims).toHaveBeenCalledWith({ now: NOW });
    expect(res.queue.recovered).toBe(3);
  });

  test("a daily member's rows are left pending until the end-of-day tick", async () => {
    setMembership({ docUpdateEmailMode: "daily" });
    pending = [queueRow("doc_updates", new Types.ObjectId()), queueRow("doc_updates", new Types.ObjectId())];

    const res = await sendNotificationEmails({ now: NOW });
    // Claiming first and asking later would park a digest's rows in `sending` for the whole day.
    expect(claimBatch).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
    expect(res.queue.deferred).toBe(2);
    expect(res.membersProcessed).toBe(1);
  });

  /**
   * And skipped in one update, without being claimed first: this branch never sends, so 500
   * sequential claims per off member per tick bought nothing that `skipPending`'s own
   * `{status: "pending"}` filter does not already give.
   */
  test("a member on off has their backlog skipped with a reason, not deleted and not sent", async () => {
    setMembership({ viewEmailMode: "off" });
    pending = [queueRow("share_views", new Types.ObjectId())];

    const res = await sendNotificationEmails({ now: NOW });
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(claimBatch).not.toHaveBeenCalled();
    expect(skipPending).toHaveBeenCalledWith({
      orgId: expect.anything(),
      userId: String(USER),
      kind: "share_views",
      reason: "member off",
      now: NOW,
    });
    expect(res.views.off.members).toBe(1);
    expect(res.queue.skipped).toBe(1);
  });

  test("a membership that is gone can never be mailed, so its rows are skipped", async () => {
    membershipFind.mockReturnValue(chain([]));
    pending = [queueRow("doc_updates", new Types.ObjectId())];

    await sendNotificationEmails({ now: NOW });
    expect(skipPending).toHaveBeenCalledWith(expect.objectContaining({ reason: "membership removed" }));
  });

  test("repo link requests stay pending while the feature is hidden", async () => {
    setMembership({ repoLinkRequestEmailMode: "immediate" });
    pending = [queueRow("repo_link_requests", new Types.ObjectId())];

    const res = await sendNotificationEmails({ now: NOW });
    expect(claimBatch).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
    expect(res.queue.deferred).toBe(1);
  });

  /**
   * The hour gate opens at 23:00 UTC and the cron runs every five minutes, so on its own it is a
   * licence to send twelve digests between 23:00 and midnight — one at 23:05, then another at
   * 23:10 for the single row a reader created at 23:07. `lastDigestDay` was the cursor model's one
   * genuinely correct piece of bookkeeping and the queue has to answer it from the queue.
   */
  test("a daily member gets one digest a day, not one every five minutes", async () => {
    setMembership({ viewEmailMode: "daily" });
    pending = [queueRow("share_views", new Types.ObjectId())];
    lastDigestSentAt = new Date(NOW.getTime() - 5 * 60_000);

    const res = await sendNotificationEmails({ now: NOW, forceDigest: true });
    expect(claimBatch).not.toHaveBeenCalled();
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(res.queue.deferred).toBe(1);
  });

  /**
   * The exception the old runner also made (`digestTruncated`): a digest that could not carry
   * everything may send the rest the same day, or a workspace busier than one digest never catches
   * up. Left-over rows are the pending ones whose event predates the digest that went out.
   */
  test("a digest that left rows behind may send again the same day", async () => {
    setMembership({ viewEmailMode: "daily" });
    const view = new Types.ObjectId();
    shareViewFind.mockReturnValue(chain([shareViewRow(view, DOC_A)]));
    docFind.mockReturnValue(chain([{ _id: DOC_A, title: "Doc One", slideNodes: [] }]));
    pending = [queueRow("share_views", view)];
    lastDigestSentAt = new Date(NOW.getTime() - 5 * 60_000);
    leftOverFromLastDigest = true;

    const res = await sendNotificationEmails({ now: NOW, forceDigest: true });
    expect(sent()).toHaveLength(1);
    expect(res.views.daily.emails).toBe(1);
  });

  /**
   * With Requests hidden the rows are kept (they go out the day the flag flips) but they are not
   * gathered as work: groups are served oldest-backlog-first and truncated at `limitMembers`, so a
   * kind that can never be delivered would sit at the head of every tick's budget forever.
   */
  test("a hidden kind is counted as deferred without taking a group slot", async () => {
    setMembership({ repoLinkRequestEmailMode: "immediate", docUpdateEmailMode: "immediate" });
    docChangeFind.mockReturnValue(chain([]));
    docFind.mockReturnValue(chain([{ _id: DOC_A, title: "Doc One" }]));
    pending = [
      queueRow("repo_link_requests", new Types.ObjectId()),
      queueRow("doc_updates", new Types.ObjectId(), { event: { docId: String(DOC_A) } }),
    ];

    const res = await sendNotificationEmails({ now: NOW, limitMembers: 1 });
    expect(res.membersTruncated).toBe(false);
    expect(res.queue.deferred).toBe(1);
    expect(res.docUpdate.immediate.emails).toBe(1);
  });

  test("an immediate member is capped per kind per tick; the rest roll into the next one", async () => {
    setMembership({ viewEmailMode: "immediate" });
    pending = Array.from({ length: 5 }, () => queueRow("share_views", new Types.ObjectId()));

    await sendNotificationEmails({ now: NOW, limitEventsPerMember: 2 });
    expect((claimBatch.mock.calls[0] as unknown[])[0]).toMatchObject({ kind: "share_views", limit: 2 });
  });

  test("more groups than limitMembers says so and leaves the rest pending", async () => {
    setMembership({ docUpdateEmailMode: "daily", viewEmailMode: "daily" });
    pending = [queueRow("doc_updates", new Types.ObjectId()), queueRow("share_views", new Types.ObjectId())];

    const res = await sendNotificationEmails({ now: NOW, limitMembers: 1 });
    expect(res.membersTruncated).toBe(true);
    expect(res.queue.deferred).toBe(1);
  });
});

describe("view emails", () => {
  const VIEW_A = new Types.ObjectId();
  const VIEW_B = new Types.ObjectId();

  beforeEach(() => {
    setMembership({ viewEmailMode: "immediate" });
    docFind.mockReturnValue(
      chain([
        { _id: DOC_A, title: "Doc One", slideNodes: [{ pageNumber: 1 }, { pageNumber: 2 }] },
        { _id: DOC_B, title: "Doc Two", slideNodes: [] },
      ]),
    );
    shareViewFind.mockReturnValue(chain([shareViewRow(VIEW_A, DOC_A), shareViewRow(VIEW_B, DOC_B)]));
    pending = [queueRow("share_views", VIEW_A), queueRow("share_views", VIEW_B)];
  });

  test("one email per document, each marking only its own rows sent", async () => {
    const res = await sendNotificationEmails({ now: NOW });
    expect(sent().map((m) => m.subject).sort()).toEqual(['Sequoia opened "Doc One"', 'Sequoia opened "Doc Two"']);
    expect(sentIds().sort()).toEqual(pending.map((r) => r.id).sort());
    expect(markSent).toHaveBeenCalledTimes(2);
    expect(res.views.immediate).toEqual({ members: 1, emails: 2, events: 2, failed: 0 });
    expect(res.queue.sent).toBe(2);
  });

  test("a failed message holds only its own rows; the other document still goes out", async () => {
    sendTextEmail.mockImplementation(async (args: any) => {
      if (String(args.subject).includes("Doc One")) throw new Error("bad RESEND_API_KEY");
      return undefined;
    });

    const res = await sendNotificationEmails({ now: NOW });
    expect(sent()).toHaveLength(2);
    expect(res.sendFailures).toBe(1);
    expect(res.views.immediate.emails).toBe(1);
    expect(res.views.immediate.failed).toBe(1);
    // The failed document's row goes back on the backoff schedule with the attempt count it was
    // claimed at; the other document's row is sent and marked, not resent next tick.
    const failedArg = (markFailed.mock.calls[0] as unknown[])[0] as { rows: Array<{ id: string; attempts: number }>; error: unknown };
    expect(failedArg.rows).toEqual([{ id: pending[0]!.id, attempts: 0 }]);
    expect((failedArg.error as Error).message).toBe("bad RESEND_API_KEY");
    expect(sentIds()).toEqual([pending[1]!.id]);
    expect(res.queue.retried).toBe(1);
    expect(res.queue.dead).toBe(0);
  });

  test("the last attempt counts as a dead letter rather than a retry", async () => {
    pending = [queueRow("share_views", VIEW_A, { attempts: 4 })];
    sendTextEmail.mockRejectedValue(new Error("nope"));

    const res = await sendNotificationEmails({ now: NOW });
    expect(res.queue.dead).toBe(1);
    expect(res.queue.retried).toBe(0);
  });

  test("a view row that no longer exists is skipped, never retried", async () => {
    shareViewFind.mockReturnValue(chain([shareViewRow(VIEW_A, DOC_A)]));

    const res = await sendNotificationEmails({ now: NOW });
    expect(markSkipped).toHaveBeenCalledWith({ ids: [pending[1]!.id], reason: "source row no longer exists", claimToken: null, now: NOW });
    expect(res.queue.skipped).toBe(1);
    expect(res.views.immediate.emails).toBe(1);
  });

  test("a deleted or archived document is skipped, and the rest of the batch still sends", async () => {
    docFind.mockReturnValue(chain([{ _id: DOC_A, title: "Doc One", slideNodes: [] }]));

    const res = await sendNotificationEmails({ now: NOW });
    expect(markSkipped).toHaveBeenCalledWith({ ids: [pending[1]!.id], reason: "document deleted or archived", claimToken: null, now: NOW });
    expect(res.views.immediate.emails).toBe(1);
  });

  test("a render that throws fails the claimed rows rather than leaving them sending forever", async () => {
    docFind.mockImplementation(() => {
      throw new Error("doc lookup exploded");
    });

    const res = await sendNotificationEmails({ now: NOW });
    const arg = (markFailed.mock.calls[0] as unknown[])[0] as { rows: Array<{ id: string }> };
    expect(arg.rows.map((r) => r.id).sort()).toEqual(pending.map((r) => r.id).sort());
    expect(res.views.errors).toBe(1);
    expect(res.queue.retried).toBe(2);
  });

  test("the one-click off link is signed with the membership, and the html reaches the transport", async () => {
    await sendNotificationEmails({ now: NOW });
    const mail = sent()[0]!;
    expect(mail.to).toBe("member@example.com");
    expect(mail.html).toContain("<!doctype html>");
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const token = mail.text.match(/\/api\/notifications\/views\/off\?t=(\S+)/)?.[1] ?? "";
    expect(verifyViewEmailsOffToken(token, { now: NOW })).toEqual({ ok: true, membershipId: String(MEMBERSHIP) });
  });

  test("an end-of-day digest is one email for every pending row, marked sent together", async () => {
    setMembership({ viewEmailMode: "daily" });

    const res = await sendNotificationEmails({ now: NOW, forceDigest: true });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.subject).toBe("2 people opened your documents today");
    expect(markSent).toHaveBeenCalledTimes(1);
    expect(sentIds().sort()).toEqual(pending.map((r) => r.id).sort());
    expect(res.views.daily).toEqual({ members: 1, emails: 1, events: 2, failed: 0, returns: 0, sentTodayUtc: true });
    // A digest is one message however many rows it covers, so the per-member cap does not apply.
    expect((claimBatch.mock.calls[0] as unknown[])[0]).toMatchObject({ limit: 500 });
  });

  /**
   * The body renders `DIGEST_MAX_DOCUMENTS` documents and replaces the rest with a headcount. Rows
   * for the documents past that were in no email, so marking them `sent` would tell
   * `wasNotified()` that this member was told about documents whose detail never left the
   * building. They come back pending instead and lead the next digest.
   */
  test("a digest bigger than the body can carry hands the overflow back rather than marking it sent", async () => {
    setMembership({ viewEmailMode: "daily" });
    const docs = Array.from({ length: DIGEST_MAX_DOCUMENTS + 3 }, () => new Types.ObjectId());
    const views = docs.map(() => new Types.ObjectId());
    docFind.mockReturnValue(chain(docs.map((id, i) => ({ _id: id, title: `Doc ${i}`, slideNodes: [] }))));
    shareViewFind.mockReturnValue(chain(views.map((v, i) => shareViewRow(v, docs[i]!))));
    pending = views.map((v, i) =>
      queueRow("share_views", v, { occurredAt: new Date(NOW.getTime() - (views.length - i) * 60_000) }),
    );

    const res = await sendNotificationEmails({ now: NOW, forceDigest: true });

    expect(sent()).toHaveLength(1);
    expect(sentIds()).toHaveLength(DIGEST_MAX_DOCUMENTS);
    const released = (releaseClaims.mock.calls[0] as unknown[])[0] as { ids: string[] };
    expect(released.ids.sort()).toEqual(
      pending
        .slice(DIGEST_MAX_DOCUMENTS)
        .map((r) => r.id)
        .sort(),
    );
    expect(res.queue.sent).toBe(DIGEST_MAX_DOCUMENTS);
    expect(res.queue.deferred).toBe(3);
    // Nothing is pretending 53 documents were reported: the body has no "3 more documents" line
    // to print, because those three are still owed.
    expect(sent()[0]!.text).not.toContain("more document");
  });

  test("identity is Pro-only, whatever the row carries", async () => {
    shareViewFind.mockReturnValue(chain([{ ...shareViewRow(VIEW_A, DOC_A), viewerName: "Roelof" }]));
    pending = [queueRow("share_views", VIEW_A)];

    await sendNotificationEmails({ now: NOW });
    expect(sent()[0]!.text).not.toContain("Roelof");
    expect(sent()[0]!.html).not.toContain("Roelof");

    sendTextEmail.mockClear();
    getWorkspacePlan.mockResolvedValue("pro");
    await sendNotificationEmails({ now: NOW });
    expect(sent()[0]!.text).toContain('Roelof opened "Doc One"');
  });

  test("no absolute site URL in production holds the rows instead of sending dead links", async () => {
    try {
      for (const k of ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_APP_URL", "NEXTAUTH_URL", "VERCEL_URL"]) vi.stubEnv(k, "");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXTAUTH_SECRET", "test-secret");

      const res = await sendNotificationEmails({ now: NOW });
      expect(claimBatch).not.toHaveBeenCalled();
      expect(sendTextEmail).not.toHaveBeenCalled();
      expect(res.views.errors).toBe(1);
      expect(res.queue.deferred).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("doc update and request emails", () => {
  const UPLOAD = new Types.ObjectId();

  beforeEach(() => {
    docChangeFind.mockReturnValue(chain([{ _id: new Types.ObjectId(), docId: DOC_A, toUploadId: UPLOAD, toVersion: 3, diff: { summary: "Pricing page rewritten" } }]));
    docFind.mockReturnValue(chain([{ _id: DOC_A, title: "Doc One" }]));
  });

  test("an immediate doc update names the document, the version, the diff and the link", async () => {
    setMembership({ docUpdateEmailMode: "immediate" });
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD), docId: String(DOC_A), version: 3 } })];

    const res = await sendNotificationEmails({ now: NOW });
    const mail = sent()[0]!;
    expect(mail.subject).toBe("Updated: Doc One");
    expect(mail.text).toContain("Doc One");
    expect(mail.text).toContain("Version: v3");
    expect(mail.text).toContain("Pricing page rewritten");
    expect(mail.text).toContain(`http://localhost:3001/doc/${String(DOC_A)}`);
    // It used to open with the workspace's ObjectId, which is not a thing to show a person.
    expect(mail.text).not.toContain(String(ORG));
    expect(mail.text).toContain("Workspace: Acme");
    expect(res.docUpdate.immediate).toEqual({ members: 1, emails: 1, events: 1, failed: 0 });
  });

  test("a doc update can be switched off from the email, and off the right setting", async () => {
    setMembership({ docUpdateEmailMode: "immediate" });
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD), docId: String(DOC_A), version: 3 } })];

    await sendNotificationEmails({ now: NOW });
    const mail = sent()[0]!;
    // These had no unsubscribe at all, which is how a recipient ends up pressing Spam instead.
    expect(mail.html).toBeTruthy();
    expect(mail.headers?.["List-Unsubscribe"]).toBeTruthy();
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const offUrl = String(mail.headers?.["List-Unsubscribe"]).replace(/^<|>$/g, "");
    const token = new URL(offUrl).searchParams.get("t") ?? "";
    const verified = verifyAnyEmailsOffToken(token, { now: NOW });
    expect(verified.ok).toBe(true);
    // The whole point of a separate purpose: this must not turn off view emails.
    expect(verified.ok && verified.kind).toBe("doc_updates");
  });

  test("the digest keeps its own wording and links to the history", async () => {
    setMembership({ docUpdateEmailMode: "daily" });
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD) } })];

    await sendNotificationEmails({ now: NOW, forceDigest: true });
    const mail = sent()[0]!;
    expect(mail.subject).toBe("1 document updated today");
    expect(mail.text).toContain("Workspace: Acme");
    expect(mail.text).toContain(`http://localhost:3001/doc/${String(DOC_A)}/history`);
  });

  /**
   * The silent loss this closes. The enqueue fires on any completed replacement; the `DocChange`
   * write is gated on both versions having extractable text and sits in a best-effort try — so
   * replacing a scanned contract with another scanned contract produces no change row at all.
   * Resolving the *document* through `DocChange` marked every member's row "source row no longer
   * exists" forever, which was both permanent and wrong: the Upload was right there, and a skipped
   * row shows as neither pending nor dead on the admin page.
   */
  test("a replacement with no DocChange still goes out, just without the diff line", async () => {
    setMembership({ docUpdateEmailMode: "immediate" });
    docChangeFind.mockReturnValue(chain([]));
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD), docId: String(DOC_A), version: 4 } })];

    const res = await sendNotificationEmails({ now: NOW });
    expect(markSkipped).not.toHaveBeenCalled();
    const mail = sent()[0]!;
    expect(mail.subject).toBe("Updated: Doc One");
    expect(mail.text).toContain("Doc One");
    expect(mail.text).toContain("Version: v4");
    expect(res.docUpdate.immediate.emails).toBe(1);
  });

  /**
   * An older row that names only its upload still resolves, through the upload itself.
   *
   * `version: null` rather than an absent key on purpose: `claimBatch` normalises a missing version
   * to `null`, so `null` is the only shape this code ever meets. Written with the key left off, the
   * event version was `undefined`, `Number(undefined)` is `NaN`, and the fallback ran — the test
   * passed while the production shape (`null`, which `Number()` turns into a perfectly finite `0`)
   * short-circuited the fallback and sent the email with no version on it.
   */
  test("a row with no document on it resolves the document through the upload", async () => {
    setMembership({ docUpdateEmailMode: "immediate" });
    docChangeFind.mockReturnValue(chain([]));
    uploadFind.mockReturnValue(chain([{ _id: UPLOAD, docId: DOC_A, version: 2 }]));
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD), version: null } })];

    await sendNotificationEmails({ now: NOW });
    expect(sent()[0]!.text).toContain("Doc One");
    expect(sent()[0]!.text).toContain("Version: v2");
  });

  /** The other half of the same fallback: the version comes off the change row, not the upload. */
  test("a row that carries no version takes it from the change row", async () => {
    setMembership({ docUpdateEmailMode: "immediate" });
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD), docId: String(DOC_A), version: null } })];

    await sendNotificationEmails({ now: NOW });
    const mail = sent()[0]!;
    expect(mail.text).toContain("Version: v3");
    // Not "v0", and not silently nothing: both are what a numeric coercion of `null` would produce.
    expect(mail.text).not.toContain("v0");
  });

  test("a doc update whose document is gone is skipped, not retried forever", async () => {
    setMembership({ docUpdateEmailMode: "immediate" });
    docFind.mockReturnValue(chain([]));
    pending = [queueRow("doc_updates", UPLOAD, { event: { uploadId: String(UPLOAD) } })];

    await sendNotificationEmails({ now: NOW });
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(markSkipped).toHaveBeenCalledWith({ ids: [pending[0]!.id], reason: "document deleted or archived", claimToken: null, now: NOW });
  });

  test("a request upload names its repo, resolving the document through the upload when the row does not", async () => {
    const REQUEST_UPLOAD = new Types.ObjectId();
    const PROJECT = new Types.ObjectId();
    setMembership({ repoLinkRequestEmailMode: "immediate" });
    uploadFind.mockReturnValue(chain([{ _id: REQUEST_UPLOAD, docId: DOC_B }]));
    docFind.mockReturnValue(chain([{ _id: DOC_B, title: "Signed NDA", receivedViaRequestProjectId: PROJECT }]));
    projectFind.mockReturnValue(chain([{ _id: PROJECT, name: "Diligence" }]));
    pending = [queueRow("repo_link_requests", REQUEST_UPLOAD)];

    try {
      vi.stubEnv("NEXT_PUBLIC_FEATURE_REQUESTS", "1");
      vi.resetModules();
      const mod = await import("@/lib/notifications/sendNotificationEmails");
      const res = await mod.sendNotificationEmails({ now: NOW });
      const mail = sent()[0]!;
      expect(mail.subject).toBe("Repo link request: Diligence");
      expect(mail.text).toContain("- Diligence: Signed NDA");
      expect(res.repoLinkRequests.immediate.emails).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("dry run", () => {
  test("claims nothing, writes nothing, sends nothing — and still reports what would go out", async () => {
    setMembership({ viewEmailMode: "immediate" });
    const view = new Types.ObjectId();
    shareViewFind.mockReturnValue(chain([shareViewRow(view, DOC_A)]));
    docFind.mockReturnValue(chain([{ _id: DOC_A, title: "Doc One", slideNodes: [] }]));
    pending = [queueRow("share_views", view)];

    const res = await sendNotificationEmails({ now: NOW, dryRun: true });
    expect(sendTextEmail).not.toHaveBeenCalled();
    expect(recoverStaleClaims).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
    // The read that stands in for the claim must carry `dryRun`, or the run leaves rows `sending`.
    expect((claimBatch.mock.calls[0] as unknown[])[0]).toMatchObject({ dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.views.immediate.emails).toBe(1);
    expect(res.queue.sent).toBe(1);
  });

  test("a dry run still reports what it would skip, without writing the skip", async () => {
    setMembership({ viewEmailMode: "off" });
    pending = [queueRow("share_views", new Types.ObjectId())];

    const res = await sendNotificationEmails({ now: NOW, dryRun: true });
    expect(markSkipped).not.toHaveBeenCalled();
    expect(res.queue.skipped).toBe(1);
    expect(res.views.off.members).toBe(1);
  });
});
