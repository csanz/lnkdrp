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
  enqueueNotifications,
  tryResolveAuthUserId,
  isOwnerSideViewer,
  viewerIdentityNews,
  upsertContact,
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
  enqueueNotifications: vi.fn(async () => ({ enqueued: 0, duplicates: 0 })),
  tryResolveAuthUserId: vi.fn(async () => null as { userId?: string } | null),
  isOwnerSideViewer: vi.fn(async () => false),
  viewerIdentityNews: vi.fn(async () => ({ isNew: true, changed: false })),
  upsertContact: vi.fn(async (_input?: Record<string, unknown>) => undefined),
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
/** The signed-in reader's account, when a test wants one. Reset in `beforeEach`. */
let signedInAccount: { name?: string | null; email?: string | null } | null = null;
vi.mock("@/lib/models/User", () => ({
  UserModel: { findById: () => ({ select: () => ({ lean: async () => signedInAccount }) }) },
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer }));
vi.mock("@/lib/share/viewerIdentity", () => ({
  viewerIdentityNews,
  propagateViewerIdentity: vi.fn(async () => undefined),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity }));
// The visit brief's clock is one best-effort upsert after the visit write; not under test here.
vi.mock("@/lib/visits/scheduleVisitBrief", () => ({ scheduleVisitBrief: vi.fn(async () => undefined) }));
vi.mock("@/lib/slack/outbox", () => ({ enqueueSlackPosts: vi.fn(async () => 0), drainSlackOutbox: vi.fn(async () => null) }));
vi.mock("@/lib/notifications/queue", () => ({
  enqueueNotifications,
  notificationDedupeKey: (...parts: unknown[]) => parts.map(String).join(":"),
}));
/** Bucket key prefixes a test wants to report as spent. Reset in `beforeEach`. */
const exhaustedBuckets: string[] = [];

// Wiring the viewer-verification control gave the introduction path two more DB-backed calls.
// Unstubbed they hang against no Mongo, which reads as a five-second timeout rather than a failure.
vi.mock("@/lib/share/viewerEmailVerification", () => ({ isViewerEmailVerified: vi.fn(async () => false) }));
// The contacts capture is one more DB-backed call on the same path (docs/prds/lnkdrp-contacts.md);
// unmocked it buffers against no database and reads as a timeout. The spy proves it still fires.
vi.mock("@/lib/contacts/service", () => ({ upsertContact }));
vi.mock("@/lib/share/viewerIntroductionEmails", () => ({
  sendViewerIntroductionEmails: vi.fn(async () => ({ verifySent: false, ownerEmailsSent: 0 })),
  viewerIntroductionAppUrl: () => "https://lnkdrp.test",
}));

/**
 * The `contactseen:` bucket, which is the only limiter here that has to remember anything.
 *
 * It *is* the once-per-sitting rule for contacts (docs/prds/lnkdrp-contacts.md decision 2): the
 * first POST of a tab session takes the slot and every heartbeat after it finds the slot spent.
 * A stateless "always ok" mock cannot see the case that mattered, where the first POST of a
 * first-ever sitting skipped the limiter entirely and the next heartbeat counted a second visit.
 * Every other bucket keeps the old behaviour.
 */
const contactSeenSpent = new Set<string>();

vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.7",
  // Buckets default to open; a test names the prefixes it wants exhausted.
  rateLimit: async ({ key }: { key: string }) => {
    if (exhaustedBuckets.some((prefix) => key.startsWith(prefix))) return { ok: false, remaining: 0, retryAfterSeconds: 60 };
    if (key.startsWith("contactseen:")) {
      const first = !contactSeenSpent.has(key);
      contactSeenSpent.add(key);
      return { ok: first, remaining: 0, retryAfterSeconds: 60 };
    }
    return { ok: true, remaining: 0, retryAfterSeconds: 60 };
  },
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
  contactSeenSpent.clear();
  signedInAccount = null;
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
    expect(enqueueNotifications).not.toHaveBeenCalled();
  });

  test("a cookie minted for another link is no cookie", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });

    await post(introduction, { cookie: unlockCookie("otherSlug1234") });
    await drainAfter();

    expect(shareViewUpdateOne).not.toHaveBeenCalled();
  });

  /**
   * A contact is one of the writes the gate holds back (docs/prds/lnkdrp-contacts.md decision 2):
   * a stranger who types a name and an address into a locked link has not read anything, and must
   * not land in the workspace's contacts. Past the gate, the same introduction captures one.
   */
  test("the gate holds the contact back, and the unlocked reader becomes one", async () => {
    resolveShareLink.mockResolvedValue({ link: link(PROTECTED), doc: doc(), refusal: null });

    await post(introduction);
    await drainAfter();
    expect(upsertContact).not.toHaveBeenCalled();

    await post(introduction, { cookie: unlockCookie() });
    await drainAfter();
    const captured = upsertContact.mock.calls[0]?.[0] as Record<string, any>;
    expect(captured.email).toBe("jane@sequoiacap.com");
    expect(captured.source).toBe("introduced");
    expect(String(captured.orgId)).toBe(String(ORG));
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

  test("a page past the end of the deck is still recorded, because the deck's length is not reliable", async () => {
    /**
     * This asserted the opposite for about an hour, and the narrowing it pinned was removed.
     *
     * The idea was sound — a page number past the last page is not a reading — but the only page
     * count available here is `Doc.slideNodes`, a render artifact. When a replacement upload's
     * slide pass fails, the *previous* version's nodes are deliberately kept while `blobUrl` moves
     * on, so a nine-page v1 can sit on a thirty-page v2. Recipients then read the thirty-page PDF
     * and every genuine reading past page nine was being thrown away: no `pagesSeen`, no heatmap,
     * no "read to page N" in the owner's mail.
     *
     * Silently discarding real readings is a worse failure than the one the narrowing was added
     * for, and it was not the finding anyway — the finding was that `pageNumber` was *unbounded*
     * and could grow the per-page maps without limit. The 1..5000 parse above is that bound, and
     * it stays.
     */
    await post(heartbeat(4000));
    await drainAfter();

    // Two writes name the page — the row's `pagesSeen` and the per-page maps — which is what a
    // real reading looks like here.
    expect(new Set(pagesAdded())).toEqual(new Set([4000]));
    expect(pagesAdded().length).toBeGreaterThan(0);
  });

  test("the 1..5000 parse is still the bound that stops the maps growing without limit", async () => {
    await post(heartbeat(500000));
    await drainAfter();

    expect(pagesAdded()).toEqual([]);
    expect(incKeys().some((k) => k.startsWith("pageTimeMsByPage."))).toBe(false);
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
    expect(enqueueNotifications).toHaveBeenCalled();
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

    expect(enqueueNotifications).not.toHaveBeenCalled();
  });

  test("the ceiling is per link, so one link under attack does not mute another", async () => {
    // Keyed on the slug, not on the workspace or the address: a bucket keyed any wider would let
    // one hammered link silence notifications for every other link the owner has.
    exhaustedBuckets.push("viewfanout:some-other-slug");
    resolveShareLink.mockResolvedValue({ link: link(), doc: doc(), refresh: null, refusal: null });

    await post(fresh);
    await drainAfter();

    expect(enqueueNotifications).toHaveBeenCalled();
  });
});

/**
 * One heartbeat, one write to the reader's row.
 *
 * It used to be three, all to the same `{shareId, botIdHash}` document: the upsert, then a second
 * to add the page, then a third to add the milliseconds. Every one of them carries `lastViewedAt`
 * and `updatedDate`, and `shareviews` has six indexes across those two fields, so a single reading
 * paid that index churn three times. One of the three was also a guaranteed no-op from the second
 * heartbeat on a page onward, because its filter excludes the page the reader is sitting on.
 *
 * This is the hot path in the product: every open, every thirty-second heartbeat, every page turn,
 * from every recipient.
 */
describe("what one heartbeat costs the reader's row", () => {
  // The `heartbeat` helper above is scoped to its own describe, so this block builds its own.
  const heartbeatOnKnownPage = () =>
    post({
      botId: "bot-of-a-stranger",
      visitId: "visit-1",
      pageNumber: 3,
      tv: 2,
      durationMs: 9_000,
      pageDurationMs: 4_000,
      enteredAtMs: Date.now() - 4_000,
      leftAtMs: Date.now(),
    });

  test("the time rides on the upsert rather than a write of its own", async () => {
    await heartbeatOnKnownPage();
    await drainAfter();

    const withInc = shareViewWrites().filter((w) => w.update.$inc);
    expect(withInc).toHaveLength(1);
    // The same write that creates the row on a first sighting.
    expect(withInc[0]!.update.$setOnInsert).toBeDefined();
  });

  test("the page write carries the page and nothing else", async () => {
    await heartbeatOnKnownPage();
    await drainAfter();

    const addWrite = shareViewWrites().find((w) => w.update.$addToSet);
    expect(addWrite).toBeDefined();
    // It used to re-send `$set: setFields`, which the upsert had already applied to the same
    // document moments earlier.
    expect(addWrite!.update.$set).toBeUndefined();
  });

  test("the reading is still recorded, which is the part that must not change", async () => {
    await heartbeatOnKnownPage();
    await drainAfter();

    expect(incKeys()).toContain("timeSpentMs");
    expect(incKeys()).toContain("pageTimeMsByPage.3");
    expect(pagesAdded()).toContain(3);
  });

  test("a lost race still records the heartbeat", async () => {
    // Two first-time POSTs for the same reader race and the unique index fails the loser. The row
    // exists, so the insert is unwanted, but the reading is not: before, the catch swallowed and
    // this heartbeat's time and identity went on the floor.
    shareViewUpdateOne.mockImplementationOnce(async () => {
      throw new Error("E11000 duplicate key error collection: shareviews");
    });

    await heartbeatOnKnownPage();
    await drainAfter();

    const retried = shareViewWrites().find((w) => w.update.$inc && !w.update.$setOnInsert);
    expect(retried).toBeDefined();
    expect(Object.keys(retried!.update.$inc)).toContain("timeSpentMs");
  });
});

/**
 * The fan-out is one insert, not one per member.
 *
 * "A new recipient opened this" owes one queue row to every member of the workspace, and that was a
 * `Promise.all` over the single-row enqueue: a `create` and a unique-index probe each. A
 * thirty-member workspace cost thirty round trips per new reader; a two-hundred-person send into it
 * cost six thousand, all inside `after()`, where nothing is retried if the lambda is frozen.
 */
describe("the new-reader fan-out", () => {
  test("the whole workspace is enqueued in a single call", async () => {
    await post({ botId: "bot-brand-new", visitId: "v1", pageNumber: 1, tv: 2 });
    await drainAfter();

    expect(enqueueNotifications).toHaveBeenCalledTimes(1);
  });

  test("it hands over one row per member, addressed individually", async () => {
    await post({ botId: "bot-brand-new-2", visitId: "v1", pageNumber: 1, tv: 2 });
    await drainAfter();

    const calls = enqueueNotifications.mock.calls as unknown as Array<Array<unknown>>;
    const rows = (calls[0]?.[0] ?? []) as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    // Per recipient, so a retry, a preference and a failure stay per person: that is the whole
    // reason the queue holds a row each rather than one row for the workspace.
    expect(new Set(rows.map((r) => String(r.userId))).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.kind).toBe("share_views");
      expect(String(row.dedupeKey)).toContain("share_views");
    }
  });
});

/**
 * One sitting is one visit (docs/prds/lnkdrp-contacts.md decision 2).
 *
 * A signed-in reader's heartbeats all arrive on the same `visitId`, so the contacts capture is
 * held to one per sitting by a `limit: 1` bucket. The bucket used to be consulted only when the
 * POST had *not* created the `ShareView` row, which meant the very first POST of a first-ever
 * sitting never spent the slot: the next heartbeat, seconds later, found it unspent and captured
 * the same reader a second time. The row then said two visits and carried two `signed_in`
 * sources for one reading, for ever, since every later sitting is correctly one.
 */
describe("a signed-in reader's first sitting", () => {
  const READER = new Types.ObjectId();
  const sitting = { botId: "bot-of-a-reader", visitId: "visit-of-a-reader", pageNumber: 1, tv: 2 };

  beforeEach(() => {
    tryResolveAuthUserId.mockResolvedValue({ userId: String(READER) });
    signedInAccount = { name: "Priya Nair", email: "Priya@SequoiaCap.com" };
  });

  /** The POST that creates the row, then the heartbeat that finds it there. */
  async function firstSittingTwoPosts() {
    await post(sitting);
    await drainAfter();
    shareViewUpdateOne.mockImplementation(async () => ({ upsertedCount: 0, modifiedCount: 1 }));
    await post(sitting);
    await drainAfter();
  }

  test("counts one visit and one source, not two", async () => {
    await firstSittingTwoPosts();

    expect(upsertContact).toHaveBeenCalledTimes(1);
    const captured = upsertContact.mock.calls[0]?.[0] as Record<string, any>;
    expect(captured.source).toBe("signed_in");
    expect(captured.email).toBe("priya@sequoiacap.com");
    expect(captured.countsAsVisit).toBe(true);
  });

  test("the next sitting is captured again: the slot is per visit, not per reader", async () => {
    await firstSittingTwoPosts();
    await post({ ...sitting, visitId: "visit-the-next-day" });
    await drainAfter();

    expect(upsertContact).toHaveBeenCalledTimes(2);
  });

  test("a reader whose browser gives no visitId is still captured on the read that created the row", async () => {
    // No `visitId` means no bucket key and no slot to take, so the created row is the only signal
    // there is. Losing that would quietly stop capturing anyone with sessionStorage blocked.
    await post({ botId: sitting.botId, pageNumber: sitting.pageNumber, tv: sitting.tv });
    await drainAfter();

    expect(upsertContact).toHaveBeenCalledTimes(1);
  });

  test("the owner reading their own link never becomes their own contact", async () => {
    isOwnerSideViewer.mockResolvedValue(true);
    await firstSittingTwoPosts();

    expect(upsertContact).not.toHaveBeenCalled();
  });
});
