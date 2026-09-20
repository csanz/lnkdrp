/**
 * Two ways `POST /api/share/:shareId/stats` took a stranger's word for it.
 *
 * **The password.** The gate on this route was written for project links only, with a comment
 * saying the document ingest had always accepted a view on a locked `/s/:shareId`. It had — and
 * `resolveShareLink` computes `refusal` from archived/disabled/expired and never looks at the
 * password, so nothing else stood in the way. Anyone holding a forwarded slug for a
 * password-protected link could POST a view, and with `introduced: true` a name and email of their
 * choosing, which the product then writes into the owner's activity feed as a named reader and
 * mails to every member of the workspace. Not a number in a chart: a lie with a person's name on
 * it. Every test here is written from that seat — anonymous, holding the URL, no cookie.
 *
 * **The page number.** `pageNumber` was parsed by a local `asPositiveInt` that floored anything
 * numeric and accepted it if it was >= 1, while its neighbours `toPage` and `numPages` went through
 * the bounded `parsePageBound`. Each distinct value becomes an entry in one `ShareView` row's
 * `pagesSeen` and a key under its `pageTimeMsByPage` map, so an unbounded parser is an unbounded
 * document — and a document past 16MB stops accepting writes, which is the owner's stats overlay
 * for that link going dark. The bound is now two-layered: 1..5000 like the neighbours, then the
 * document's own page count.
 *
 * Both are pinned as writes-issued assertions (the style of tests/lib/duplicateOrTenancy.test.ts):
 * the rule has to hold at the query, because that is where the damage is.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const DOC = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const ORG = new Types.ObjectId();
const SHARE_ID = "srDP4SzZNA5a";
const PASSWORD_HASH = "qN0tArEaLhAsH";
/** The deck really has three pages. Anything past it is not a reading. */
const REAL_PAGES = 3;

const {
  afterCallbacks,
  resolveShareLink,
  touchShareLink,
  resolveProjectStatsTarget,
  shareViewUpdateOne,
  shareViewCountDocuments,
  shareViewAggregate,
  shareVisitUpdateOne,
  docUpdateOne,
  recordActivity,
  enqueueNotification,
  tryResolveAuthUserId,
  isOwnerSideViewer,
  viewerIdentityNews,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  resolveShareLink: vi.fn(),
  touchShareLink: vi.fn(),
  resolveProjectStatsTarget: vi.fn(async () => null),
  shareViewUpdateOne: vi.fn(),
  shareViewCountDocuments: vi.fn(async () => 0),
  shareViewAggregate: vi.fn(async () => [] as unknown[]),
  shareVisitUpdateOne: vi.fn(async () => ({ acknowledged: true })),
  docUpdateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  recordActivity: vi.fn(async () => undefined),
  enqueueNotification: vi.fn(async () => undefined),
  tryResolveAuthUserId: vi.fn(async () => null as { userId?: string } | null),
  isOwnerSideViewer: vi.fn(async () => false),
  viewerIdentityNews: vi.fn(async () => ({ isNew: true, changed: false })),
}));

// `after()` is where every analytics write in this route lives, so the tests have to be able to run
// it. Everything else in `next/server` (NextResponse above all) stays real.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterCallbacks.push(fn);
  },
}));
// Partial, for the same reason as tests/lib/sharePasswordGate.test.ts: the route must run against
// the *real* `shareLinkUnlocked` — a mocked gate would test nothing — while `resolveShareLink`
// stands in for the database.
vi.mock("@/lib/share/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/share/links")>()),
  resolveShareLink,
  touchShareLink,
}));
vi.mock("@/lib/share/projectPublic", () => ({
  resolveProjectStatsTarget,
  projectViewerKey: (hash: string, docId: string) => `${hash}.${docId}`,
}));
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({
  withMongoRequestLogging: (_request: Request, fn: () => Promise<Response>) => fn(),
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { updateOne: docUpdateOne } }));
vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: {
    updateOne: shareViewUpdateOne,
    countDocuments: shareViewCountDocuments,
    aggregate: shareViewAggregate,
  },
}));
vi.mock("@/lib/models/ShareVisit", () => ({ ShareVisitModel: { updateOne: shareVisitUpdateOne } }));
vi.mock("@/lib/models/ProjectLinkView", () => ({ ProjectLinkViewModel: { updateOne: vi.fn(async () => ({})) } }));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { find: () => ({ select: () => ({ lean: async () => [{ userId: OWNER }] }) }) },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer }));
vi.mock("@/lib/share/viewerIdentity", () => ({
  viewerIdentityNews,
  propagateViewerIdentity: vi.fn(async () => undefined),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity }));
vi.mock("@/lib/notifications/queue", () => ({
  enqueueNotification,
  notificationDedupeKey: (...parts: unknown[]) => parts.map(String).join(":"),
}));
/** Bucket key prefixes a test wants to report as spent. Reset in `beforeEach`. */
const exhaustedBuckets: string[] = [];

// Wiring the viewer-verification control gave the introduction path two more DB-backed calls.
// Unstubbed they hang against no Mongo, which reads as a five-second timeout rather than a failure.
vi.mock("@/lib/share/viewerEmailVerification", () => ({ isViewerEmailVerified: vi.fn(async () => false) }));
vi.mock("@/lib/share/viewerIntroductionEmails", () => ({
  sendViewerIntroductionEmails: vi.fn(async () => ({ verifySent: false, ownerEmailsSent: 0 })),
  viewerIntroductionAppUrl: () => "https://lnkdrp.test",
}));

vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.7",
  // Buckets default to open; a test names the prefixes it wants exhausted.
  rateLimit: async ({ key }: { key: string }) => ({
    ok: !exhaustedBuckets.some((prefix) => key.startsWith(prefix)),
    remaining: 0,
    retryAfterSeconds: 60,
  }),
  rateLimitedResponse: () => new Response("rate limited", { status: 429 }),
}));

const { GET, POST } = await import("@/app/api/share/[shareId]/stats/route");
const { shareAuthCookieName, shareAuthCookieValue } = await import("@/lib/sharePassword");

// --- fixtures ----------------------------------------------------------------------------------

/** A link row as `resolveShareLink` hands it back. */
function link(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    shareId: SHARE_ID,
    label: "Sequoia",
    isDefault: true,
    passwordHash: null as string | null,
    passwordSalt: null as string | null,
    ...overrides,
  };
}

const PROTECTED = { passwordHash: PASSWORD_HASH, passwordSalt: "saltysalt" };

/** The document as the route selects it: title plus the slide nodes that give its page count. */
function doc(pages = REAL_PAGES) {
  return {
    _id: DOC,
    userId: OWNER,
    orgId: ORG,
    title: "Series A deck",
    slideNodes: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1 })),
  };
}

/** The cookie `POST /api/share/:shareId/unlock` hands a recipient who typed the password. */
function unlockCookie(shareId = SHARE_ID, sharePasswordHash = PASSWORD_HASH): string {
  return `${shareAuthCookieName(shareId)}=${shareAuthCookieValue({ shareId, sharePasswordHash })}`;
}

/** One ingest POST, with or without the unlock cookie. */
function post(body: Record<string, unknown>, opts: { cookie?: string } = {}) {
  return POST(
    new Request(`https://lnkdrp.test/api/share/${SHARE_ID}/stats`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ shareId: SHARE_ID }) },
  );
}

/** Run the analytics block the route deferred, the way the platform would. */
async function drainAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0, afterCallbacks.length);
  for (const fn of pending) await fn();
}

/** Every `ShareViewModel.updateOne` this request issued, filter and update. */
function shareViewWrites(): Array<{ filter: Record<string, any>; update: Record<string, any> }> {
  return shareViewUpdateOne.mock.calls.map((c: any[]) => ({ filter: c[0] ?? {}, update: c[1] ?? {} }));
}

/** The keys any `$inc` on a `ShareView`/`ShareVisit` write touched (`pageTimeMsByPage.7`, …). */
function incKeys(): string[] {
  return [...shareViewUpdateOne.mock.calls, ...shareVisitUpdateOne.mock.calls].flatMap((c: any[]) =>
    Object.keys((c[1] as Record<string, any>)?.$inc ?? {}),
  );
}

/** The page numbers that reached a `$addToSet: { pagesSeen }` on either collection. */
function pagesAdded(): unknown[] {
  return [...shareViewUpdateOne.mock.calls, ...shareVisitUpdateOne.mock.calls]
    .map((c: any[]) => (c[1] as Record<string, any>)?.$addToSet?.pagesSeen)
    .filter((v) => v !== undefined);
}

beforeEach(() => {
  exhaustedBuckets.length = 0;
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  resolveShareLink.mockResolvedValue({ link: link(), doc: doc(), refusal: null });
  resolveProjectStatsTarget.mockResolvedValue(null);
  tryResolveAuthUserId.mockResolvedValue(null);
  isOwnerSideViewer.mockResolvedValue(false);
  viewerIdentityNews.mockResolvedValue({ isNew: true, changed: false });
  // The row does not exist yet: this POST is a brand-new viewer, which is the case that writes the
  // most — the view counter, the activity row and the owner's mail all hang off it.
  shareViewUpdateOne.mockImplementation(async (_filter: unknown, _update: unknown, opts?: { upsert?: boolean }) =>
    opts?.upsert ? { upsertedCount: 1, upsertedId: new Types.ObjectId() } : { modifiedCount: 1 },
  );
});

// --- the password gate -------------------------------------------------------------------------

describe("POST on a password-protected document link", () => {
  const introduction = {
    botId: "bot-of-a-stranger",
    visitId: "visit-1",
    pageNumber: 1,
    introduced: true,
    viewerName: "Jane Partner",
    viewerEmail: "jane@sequoiacap.com",
  };

  test("a caller with no unlock cookie writes nothing at all", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });

    const res = await post(introduction);
    await drainAfter();

    // Quiet 200, like the landing ingest: a recipient whose browser refuses the cookie must not see
    // an error in the console of a page that is otherwise working.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Nothing deferred, because the route returned before `after()`.
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(shareVisitUpdateOne).not.toHaveBeenCalled();
    expect(docUpdateOne).not.toHaveBeenCalled();
    expect(touchShareLink).not.toHaveBeenCalled();
  });

  test("no invented reader reaches the activity feed or the owner's mail", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });

    await post(introduction);
    await drainAfter();

    expect(recordActivity).not.toHaveBeenCalled();
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  test("a cookie minted for another link is no cookie", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });

    await post(introduction, { cookie: unlockCookie("otherSlug1234") });
    await drainAfter();

    expect(shareViewUpdateOne).not.toHaveBeenCalled();
  });

  test("the recipient who did enter the password is recorded as before", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });

    await post(introduction, { cookie: unlockCookie() });
    await drainAfter();

    const upsert = shareViewWrites().find((w) => w.update.$setOnInsert);
    expect(upsert?.filter.shareId).toBe(SHARE_ID);
    expect(docUpdateOne).toHaveBeenCalledWith({ _id: DOC }, { $inc: { numberOfViews: 1 } });
    expect(recordActivity).toHaveBeenCalled();
  });

  test("a link with no password needs no cookie", async () => {
    await post(introduction);
    await drainAfter();

    expect(shareViewWrites().some((w) => w.update.$setOnInsert)).toBe(true);
  });
});

describe("GET on a password-protected link", () => {
  test("the owner's own overlay is answered only behind the gate", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });
    tryResolveAuthUserId.mockResolvedValue({ userId: String(OWNER) });

    const res = await GET(new Request(`https://lnkdrp.test/api/share/${SHARE_ID}/stats`), {
      params: Promise.resolve({ shareId: SHARE_ID }),
    });

    // `/s/[shareId]` has no owner exemption either, so the overlay is only ever read from a page
    // that already passed the gate. Same shape a stranger gets, so the viewer just shows no overlay.
    expect(await res.json()).toEqual({ isOwner: false });
    expect(shareViewCountDocuments).not.toHaveBeenCalled();
    expect(shareViewAggregate).not.toHaveBeenCalled();
  });

  test("with the cookie, the owner still gets their numbers", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });
    tryResolveAuthUserId.mockResolvedValue({ userId: String(OWNER) });
    shareViewCountDocuments.mockResolvedValue(4);
    shareViewAggregate.mockResolvedValue([{ pagesViewed: 2 }]);

    const res = await GET(
      new Request(`https://lnkdrp.test/api/share/${SHARE_ID}/stats`, { headers: { cookie: unlockCookie() } }),
      { params: Promise.resolve({ shareId: SHARE_ID }) },
    );

    expect(await res.json()).toEqual({ isOwner: true, stats: { views: 4, pagesViewed: 2 } });
  });
});

// --- the page number ---------------------------------------------------------------------------

describe("pageNumber bounds", () => {
  const heartbeat = (pageNumber: unknown) => ({
    botId: "bot-of-a-stranger",
    visitId: "visit-1",
    pageNumber,
    tv: 2,
    durationMs: 9000,
    pageDurationMs: 4000,
    enteredAtMs: Date.now() - 4000,
    leftAtMs: Date.now(),
    reason: "turn",
  });

  test("an absurd page number is dropped before it can grow the row", async () => {
    await post(heartbeat(9e15));
    await drainAfter();

    expect(pagesAdded()).toEqual([]);
    expect(incKeys().some((k) => k.startsWith("pageTimeMsByPage."))).toBe(false);
    expect(incKeys().some((k) => k.startsWith("pageVisitCountByPage."))).toBe(false);
    expect(docUpdateOne).not.toHaveBeenCalledWith(expect.anything(), { $inc: { numberOfPagesViewed: 1 } });
  });

  test("a page past the end of the deck is not a reading, even inside the 5000 ceiling", async () => {
    // Three real pages; 4000 parses fine and is pure invention.
    await post(heartbeat(4000));
    await drainAfter();

    expect(pagesAdded()).toEqual([]);
    expect(docUpdateOne).not.toHaveBeenCalledWith(expect.anything(), { $inc: { numberOfPagesViewed: 1 } });
  });

  test("the visit is still recorded: a bad page number skips the page, not the reader", async () => {
    await post(heartbeat(4000));
    await drainAfter();

    expect(shareViewWrites().some((w) => w.update.$setOnInsert)).toBe(true);
    expect(shareVisitUpdateOne).toHaveBeenCalled();
    expect(incKeys()).toContain("timeSpentMs");
  });

  test("a real page in a real deck is counted exactly as before", async () => {
    await post(heartbeat(2));
    await drainAfter();

    expect(pagesAdded()).toContain(2);
    expect(docUpdateOne).toHaveBeenCalledWith({ _id: DOC }, { $inc: { numberOfPagesViewed: 1 } });
    expect(incKeys()).toContain("pageTimeMsByPage.2");
  });

  test("a document still processing has no page count to check against, so the ceiling is the bound", async () => {
    // No slide nodes yet: a real recipient reading page 7 of a deck that has not been rendered must
    // still be counted, which is why an unknown count is not treated as zero pages.
    resolveShareLink.mockResolvedValue({ link: link(), doc: { ...doc(0), slideNodes: [] }, refusal: null });

    await post(heartbeat(7));
    await drainAfter();

    expect(pagesAdded()).toContain(7);
  });
});

/**
 * A reading that the owner is *told* about costs one queued email per member of the workspace, and
 * the thing that decides "is this a new reader" is `botId` — which comes from the request body. A
 * stranger with the link who rotates it per request is a stranger who mints an unbounded number of
 * first-time readers, each fanning out to every mailbox in the workspace.
 *
 * `viewfanout:<shareId>` is the ceiling: per link, per day, counted only when a brand-new
 * `ShareView` row is actually created. What is pinned here is the *shape* of the response to
 * hitting it — the reading is still recorded, and only the two things that reach a person are
 * skipped. Suppressing what the owner can look up would hide real traffic; suppressing what is
 * pushed at them does not.
 */
describe("the ceiling on new readers per link", () => {
  const fresh = {
    botId: "bot-never-seen-before",
    visitId: "visit-9",
    pageNumber: 1,
    introduced: true,
    viewerName: "Someone New",
    viewerEmail: "new@example.com",
  };

  test("an ordinary first-time reader is recorded and announced", async () => {
    resolveShareLink.mockResolvedValue({ link: link(), doc: doc(), refresh: null, refusal: null });

    await post(fresh);
    await drainAfter();

    expect(shareViewUpdateOne).toHaveBeenCalled();
    expect(enqueueNotification).toHaveBeenCalled();
  });

  test("past the ceiling the reading is still recorded", async () => {
    exhaustedBuckets.push("viewfanout:");
    resolveShareLink.mockResolvedValue({ link: link(), doc: doc(), refresh: null, refusal: null });

    await post(fresh);
    await drainAfter();

    // The metrics page must keep telling the truth, whatever the mail does.
    expect(shareViewUpdateOne).toHaveBeenCalled();
  });

  test("past the ceiling nobody's mailbox is touched", async () => {
    exhaustedBuckets.push("viewfanout:");
    resolveShareLink.mockResolvedValue({ link: link(), doc: doc(), refresh: null, refusal: null });

    await post(fresh);
    await drainAfter();

    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  test("the ceiling is per link, so one link under attack does not mute another", async () => {
    // Keyed on the slug, not on the workspace or the address: a bucket keyed any wider would let
    // one hammered link silence notifications for every other link the owner has.
    exhaustedBuckets.push("viewfanout:some-other-slug");
    resolveShareLink.mockResolvedValue({ link: link(), doc: doc(), refresh: null, refusal: null });

    await post(fresh);
    await drainAfter();

    expect(enqueueNotification).toHaveBeenCalled();
  });
});
