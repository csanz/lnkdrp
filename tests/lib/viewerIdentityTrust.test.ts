/**
 * Two ways the product took an anonymous caller's word for it on the recipient-facing write paths.
 *
 * **Who they say they are (M27).** "Introduce yourself" is answered by an unauthenticated POST, and
 * `propagateViewerIdentity` wrote that answer across `{ orgId }` — every analytics row in the
 * workspace whose key matched the caller's own `botId` digest. Nothing proved the address was the
 * caller's: the confirmation mail, the token it carries and the `/share/verify` page that consumes
 * it all existed, and `sendViewerIntroductionEmails` — the one function that mints the token — was
 * called from nowhere. So a stranger holding a share link could stamp a named partner at a real
 * company across the owner's whole workspace, and rotate `botId` to mint as many of them as they
 * liked. Now an unproved claim is written only within the link it was made on, and the two routes
 * that can receive an introduction actually send the confirmation.
 *
 * **How many times they came (L7).** `POST /api/share/:shareId/landing` deduplicated its visit
 * counter on `visitIdHashes: { $ne: visitIdHash }`, and `visitId` came straight off the body — so
 * the deduplication was the caller's to defeat. A constant `botId` with a fresh `visitId` each call
 * kept everything on one real recipient's row (no new rows, no `project.landed` in the feed) while
 * `visits` and `landingsByDay.<today>` climbed at the per-IP limiter's 60 a minute.
 *
 * Both are pinned as writes-issued assertions — the style of tests/lib/statsIngestBounds.test.ts
 * and tests/lib/crossTenantScoping.test.ts — because the rule has to hold at the query: that is
 * where the damage is, and a response body would tell us nothing either way.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const LINK = new Types.ObjectId();
const SHARE_ID = "prQ7vZk2Lm4x";
/** A viewer digest, in the sha256 shape `viewerKeyMatchClause` recognises as one. */
const VIEWER_KEY = "a".repeat(64);

const {
  afterCallbacks,
  shareViewUpdateMany,
  shareViewFindOne,
  projectViewUpdateMany,
  projectViewUpdateOne,
  projectViewFindOne,
  isViewerEmailVerified,
  sendViewerIntroductionEmails,
  resolveProjectLink,
  findProjectDocument,
  projectLinkPasswordEnabled,
  isOwnerSideViewer,
  tryResolveAuthUserId,
  recordActivity,
  rateLimit,
  upsertContact,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  shareViewUpdateMany: vi.fn(async (_filter?: Record<string, any>, _update?: Record<string, any>) => ({ modifiedCount: 1 })),
  shareViewFindOne: vi.fn(),
  projectViewUpdateMany: vi.fn(async (_filter?: Record<string, any>, _update?: Record<string, any>) => ({ modifiedCount: 0 })),
  projectViewUpdateOne: vi.fn(async (_filter?: Record<string, any>, _update?: Record<string, any>) => ({ modifiedCount: 1 })),
  projectViewFindOne: vi.fn(),
  isViewerEmailVerified: vi.fn(async () => false),
  sendViewerIntroductionEmails: vi.fn(async (_args?: Record<string, any>) => ({ verifySent: true, ownerEmailsSent: 0 })),
  resolveProjectLink: vi.fn(),
  findProjectDocument: vi.fn(async () => null),
  projectLinkPasswordEnabled: vi.fn(() => false),
  isOwnerSideViewer: vi.fn(async () => false),
  tryResolveAuthUserId: vi.fn(async () => null as { userId?: string } | null),
  recordActivity: vi.fn(async () => undefined),
  rateLimit: vi.fn(async (_input: { key: string }) => ({ ok: true, remaining: 1, retryAfterSec: 0 })),
  upsertContact: vi.fn(async (_input?: Record<string, unknown>) => undefined),
}));

// `after()` is where every write on the landing route lives, so the tests have to be able to run
// it. Everything else in `next/server` (NextResponse above all) stays real.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterCallbacks.push(fn);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({
  withMongoRequestLogging: (_request: Request, fn: () => Promise<Response>) => fn(),
}));

// Both chain shapes the code under test uses: `findOne().select().sort().lean()` for the "is this
// news" read, and the bare `updateMany` / `updateOne` whose *filters* are what these tests assert.
const chain = (mock: ReturnType<typeof vi.fn>) => (...args: unknown[]) => {
  mock(...args);
  return { select: () => ({ sort: () => ({ lean: async () => null }) }) };
};

vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: { updateMany: shareViewUpdateMany, findOne: chain(shareViewFindOne) },
}));
vi.mock("@/lib/models/ProjectLinkView", () => ({
  VISIT_ID_HASH_CAP: 50,
  ProjectLinkViewModel: {
    updateMany: projectViewUpdateMany,
    updateOne: projectViewUpdateOne,
    findOne: chain(projectViewFindOne),
  },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findById: () => ({ select: () => ({ lean: async () => null }) }) },
}));
// The verification record. `propagateViewerIdentity` asks it one question — "has this workspace
// had a confirmed click for this address" — and that answer is the whole fan-out decision.
vi.mock("@/lib/share/viewerEmailVerification", () => ({ isViewerEmailVerified }));
// The contacts capture is one more DB-backed call on the same path (docs/prds/lnkdrp-contacts.md);
// unmocked it buffers against no database and reads as a timeout. The spy proves it still fires.
vi.mock("@/lib/contacts/service", () => ({ upsertContact }));
vi.mock("@/lib/share/viewerIntroductionEmails", () => ({
  sendViewerIntroductionEmails,
  viewerIntroductionAppUrl: () => "https://lnkdrp.test",
}));
vi.mock("@/lib/share/projectLinks", () => ({ resolveProjectLink }));
// Partial: `splitProjectViewerKey` and `viewerKeyMatchClause` must be the real ones, because the
// shape of the key match is half of what `propagateViewerIdentity` writes.
vi.mock("@/lib/share/projectPublic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/share/projectPublic")>()),
  findProjectDocument,
  projectLinkPasswordEnabled,
}));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId }));
vi.mock("@/lib/activity/log", () => ({ recordActivity }));
vi.mock("@/lib/slack/outbox", () => ({ enqueueSlackPosts: vi.fn(async () => 0), drainSlackOutbox: vi.fn(async () => null) }));
vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.7",
  rateLimit,
  rateLimitedResponse: () => new Response("rate limited", { status: 429 }),
}));

const { propagateViewerIdentity } = await import("@/lib/share/viewerIdentity");
const { POST } = await import("@/app/api/share/[shareId]/landing/route");

// --- helpers -----------------------------------------------------------------------------------

/** One landing POST from a stranger holding the slug: anonymous, no cookie. */
function post(body: Record<string, unknown>) {
  return POST(
    new Request(`https://lnkdrp.test/api/share/${SHARE_ID}/landing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ shareId: SHARE_ID }) },
  );
}

/** Run the block the route deferred, the way the platform would. */
async function drainAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0, afterCallbacks.length);
  for (const fn of pending) await fn();
}

/** The filters every `ProjectLinkViewModel.updateOne` this request issued was anchored on. */
function projectWrites(): Array<{ filter: Record<string, any>; update: Record<string, any> }> {
  return projectViewUpdateOne.mock.calls.map((c: any[]) => ({ filter: c[0] ?? {}, update: c[1] ?? {} }));
}

/** The writes that move the two figures a sender reads: `visits` and the per-day chart. */
function countingWrites() {
  return projectWrites().filter((w) => w.update?.$inc && "visits" in w.update.$inc);
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  isViewerEmailVerified.mockResolvedValue(false);
  projectLinkPasswordEnabled.mockReturnValue(false);
  isOwnerSideViewer.mockResolvedValue(false);
  tryResolveAuthUserId.mockResolvedValue(null);
  rateLimit.mockResolvedValue({ ok: true, remaining: 1, retryAfterSec: 0 });
  projectViewUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  shareViewUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  projectViewUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  resolveProjectLink.mockResolvedValue({
    link: { _id: LINK, shareId: SHARE_ID, label: "Sequoia", isDefault: true, passwordHash: null },
    project: { _id: PROJECT, orgId: ORG, name: "Series A room", slug: "series-a" },
    refusal: null,
  });
});

// --- M27: a claim is not a fact ---------------------------------------------------------------

describe("propagateViewerIdentity: how far an unproved claim travels", () => {
  test("an unconfirmed address is written only within the link it was claimed on", async () => {
    await propagateViewerIdentity({
      shareId: SHARE_ID,
      botIdHash: VIEWER_KEY,
      orgId: ORG,
      name: "Dana Whitfield",
      email: "dana@sequoiacap.com",
      emailVerified: false,
    });

    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter).toBeTruthy();
    expect(filter.shareId).toBe(SHARE_ID);
    expect(filter.orgId).toBeUndefined();

    const projectFilter = projectViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(projectFilter.shareId).toBe(SHARE_ID);
    expect(projectFilter.orgId).toBeUndefined();
  });

  test("a name with no address at all is a claim too, and stays on its own link", async () => {
    await propagateViewerIdentity({
      shareId: SHARE_ID,
      botIdHash: VIEWER_KEY,
      orgId: ORG,
      name: "Dana Whitfield",
      email: null,
      // Even asserted as verified, a bare name has no address that could have been confirmed.
      emailVerified: true,
    });

    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter.shareId).toBe(SHARE_ID);
    expect(filter.orgId).toBeUndefined();
  });

  test("a confirmed address still reaches the whole workspace, which is the feature", async () => {
    await propagateViewerIdentity({
      shareId: SHARE_ID,
      botIdHash: VIEWER_KEY,
      orgId: ORG,
      name: "Dana Whitfield",
      email: "Dana@SequoiaCap.com",
      emailVerified: true,
    });

    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(String(filter.orgId)).toBe(String(ORG));
    expect(filter.shareId).toBeUndefined();
  });

  test("a caller that says nothing gets the narrow scope, never the wide one", async () => {
    // The safe default matters because it is what a future third caller — or a route whose
    // verification lookup threw — will pass without meaning to.
    await propagateViewerIdentity({
      shareId: SHARE_ID,
      botIdHash: VIEWER_KEY,
      orgId: ORG,
      name: "Dana Whitfield",
      email: "dana@sequoiacap.com",
    });

    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter.shareId).toBe(SHARE_ID);
    expect(filter.orgId).toBeUndefined();
  });

  test("the two other guards are untouched: never over an account identity, only where it differs", async () => {
    await propagateViewerIdentity({
      shareId: SHARE_ID,
      botIdHash: VIEWER_KEY,
      orgId: ORG,
      name: "Dana Whitfield",
      email: "dana@sequoiacap.com",
      emailVerified: true,
    });

    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    const guards = JSON.stringify(filter.$and ?? []);
    expect(guards).toContain("viewerUserId");
    expect(guards).toContain("viewerName");
  });
});

describe("the landing route mints the confirmation that makes a claim provable", () => {
  test("an introduction sends the confirmation mail, keyed on the person", async () => {
    await post({ botId: "constant-bot", viewerName: "Dana Whitfield", viewerEmail: "dana@sequoiacap.com" });
    await drainAfter();

    expect(sendViewerIntroductionEmails).toHaveBeenCalledTimes(1);
    const args = sendViewerIntroductionEmails.mock.calls[0]?.[0] as Record<string, any>;
    expect(args.email).toBe("dana@sequoiacap.com");
    expect(args.shareId).toBe(SHARE_ID);
    expect(String(args.orgId)).toBe(String(ORG));
    // A bare digest, never a `<digest>.<docId>` composite: the token is about a reader.
    expect(args.viewerKey).toMatch(/^[a-f0-9]{64}$/);
    expect(args.appUrl).toBe("https://lnkdrp.test");
  });

  test("the owner testing their own link mails nobody", async () => {
    isOwnerSideViewer.mockResolvedValue(true);

    await post({ botId: "constant-bot", viewerName: "Dana Whitfield", viewerEmail: "dana@sequoiacap.com" });
    await drainAfter();

    expect(sendViewerIntroductionEmails).not.toHaveBeenCalled();
  });

  /**
   * The same introduction is the first of the four moments that make a contact
   * (docs/prds/lnkdrp-contacts.md decision 2). Capture is wired here, next to the mail, and carries
   * the same owner guard: a founder previewing their own room is not their own first contact.
   */
  test("an introduction becomes a contact, and the owner's preview does not", async () => {
    await post({ botId: "constant-bot", viewerName: "Dana Whitfield", viewerEmail: "dana@sequoiacap.com" });
    await drainAfter();

    expect(upsertContact).toHaveBeenCalledTimes(1);
    const captured = upsertContact.mock.calls[0]?.[0] as Record<string, any>;
    expect(captured.email).toBe("dana@sequoiacap.com");
    expect(captured.name).toBe("Dana Whitfield");
    expect(captured.source).toBe("introduced");
    expect(String(captured.orgId)).toBe(String(ORG));

    upsertContact.mockClear();
    isOwnerSideViewer.mockResolvedValue(true);
    await post({ botId: "constant-bot", viewerName: "Dana Whitfield", viewerEmail: "dana@sequoiacap.com" });
    await drainAfter();
    expect(upsertContact).not.toHaveBeenCalled();
  });

  test("an arrival with a name and no address makes no contact", async () => {
    await post({ botId: "constant-bot", viewerName: "Dana Whitfield" });
    await drainAfter();

    expect(upsertContact).not.toHaveBeenCalled();
  });

  test("an arrival with no introduction mails nobody", async () => {
    await post({ botId: "constant-bot" });
    await drainAfter();

    expect(sendViewerIntroductionEmails).not.toHaveBeenCalled();
  });

  /**
   * End to end through the real `propagateViewerIdentity`: the route asks whether the address is
   * confirmed, and the answer is what the fan-out is scoped on. This is the assertion that would
   * have caught the original bug from the outside — one anonymous POST, and the write it issues.
   */
  test("a stranger's claim reaches one link, not the workspace", async () => {
    isViewerEmailVerified.mockResolvedValue(false);

    await post({ botId: "constant-bot", viewerName: "Dana Whitfield", viewerEmail: "dana@sequoiacap.com" });
    await drainAfter();

    expect(isViewerEmailVerified).toHaveBeenCalledWith(String(ORG), "dana@sequoiacap.com");
    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter?.shareId).toBe(SHARE_ID);
    expect(filter?.orgId).toBeUndefined();
  });

  test("once that address is confirmed, the same claim reaches the workspace", async () => {
    isViewerEmailVerified.mockResolvedValue(true);

    await post({ botId: "constant-bot", viewerName: "Dana Whitfield", viewerEmail: "dana@sequoiacap.com" });
    await drainAfter();

    const filter = shareViewUpdateMany.mock.calls[0]?.[0] as Record<string, any>;
    expect(String(filter?.orgId)).toBe(String(ORG));
    expect(filter?.shareId).toBeUndefined();
  });
});

// --- L7: a visit the caller cannot mint at will ------------------------------------------------

describe("landing visit counts", () => {
  test("a genuine first visit still counts, and still claims its session id", async () => {
    await post({ botId: "constant-bot", visitId: "tab-1" });
    await drainAfter();

    const counted = countingWrites();
    expect(counted).toHaveLength(1);
    expect(Object.keys(counted[0].update.$inc)).toEqual(
      expect.arrayContaining(["visits", `landingsByDay.${new Date().toISOString().slice(0, 10)}`]),
    );

    // The session id is claimed by its own guarded write, so two tabs cannot both believe they
    // were first — and the claim is what spends the budget, not the request.
    const claim = projectWrites().find((w) => w.update?.$push?.visitIdHashes);
    expect(claim?.filter.visitIdHashes).toEqual({ $ne: expect.any(String) });
  });

  test("a reload on the same tab session counts nothing, and spends no budget", async () => {
    // The `$ne` guard matched nothing: this session id is already on the row.
    projectViewUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    await post({ botId: "constant-bot", visitId: "tab-1" });
    await drainAfter();

    expect(countingWrites()).toHaveLength(0);
    expect(rateLimit.mock.calls.map((c: any[]) => String(c[0]?.key))).not.toContainEqual(
      expect.stringContaining("landingvisits:"),
    );
  });

  test("rotating visitId past the per-viewer budget stops moving the figures", async () => {
    // Everything the caller controls says "a brand new tab session"; the server-side budget for
    // this (link, viewer) row is spent.
    rateLimit.mockImplementation(async ({ key }: { key: string }) => ({
      ok: !key.startsWith("landingvisits:"),
      remaining: 0,
      retryAfterSec: 60,
    }));

    await post({ botId: "constant-bot", visitId: "fresh-random-1" });
    await drainAfter();

    expect(countingWrites()).toHaveLength(0);
    // The budget is per (link, viewer), not per IP: an attacker rotating IPs must still burn one
    // row's allowance, and rotating `botId` instead grows rows, which the feed announces.
    const budgetKeys = rateLimit.mock.calls
      .map((c: any[]) => String(c[0]?.key))
      .filter((k: string) => k.startsWith("landingvisits:"));
    expect(budgetKeys).toHaveLength(1);
    expect(budgetKeys[0]).toContain(SHARE_ID);
  });

  test("past the budget the visit is still recorded, and the arrival row still written", async () => {
    rateLimit.mockImplementation(async ({ key }: { key: string }) => ({
      ok: !key.startsWith("landingvisits:"),
      remaining: 0,
      retryAfterSec: 60,
    }));

    await post({ botId: "constant-bot", visitId: "fresh-random-2" });
    await drainAfter();

    // Degrades, never refuses: the session id is remembered (so it can never be counted later
    // either), the arrival row is upserted, and only the two counters hold still.
    expect(projectWrites().some((w) => w.update?.$push?.visitIdHashes)).toBe(true);
    expect(projectWrites().some((w) => w.update?.$setOnInsert?.shareId === SHARE_ID)).toBe(true);
  });
});
