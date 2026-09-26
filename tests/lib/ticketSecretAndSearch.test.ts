/**
 * Two findings that share a shape: a bound that was supposed to be narrow and wasn't.
 *
 * - **L8, live.** `realtimeSecret()` returned `NEXTAUTH_SECRET` verbatim when `REALTIME_SECRET`
 *   was unset. `NEXTAUTH_SECRET` is the fallback behind five independent key derivations — session
 *   cookies, the AES key over every share password at rest, the AES key over org invite tokens,
 *   view-notification tokens, and the internal upload-processing HMAC — and the two components
 *   that consume this module (`realtime/server.ts`, `mcp/src/realtime.ts`) are separate
 *   deployments whose whole legitimate need is one 60-second HMAC key. They were handed the master
 *   key instead. The fix derives a purpose-bound key with HKDF rather than refusing to start, so a
 *   single-secret deploy keeps working and the value those processes can leak is only a ticket key.
 *
 *   The first shape of that fix derived only when it could *see* that the configured secret was the
 *   master (`dedicated !== master`), which made the key depend on whether `NEXTAUTH_SECRET` happened
 *   to be in that process — and it is deliberately absent from the realtime and MCP hosts. The key
 *   is now derived unconditionally, so it is a function of the configured secret and nothing else;
 *   the tests below pin both halves: same input → same key on any host, and the raw secret (either
 *   one) is never the key.
 *
 * - **L9, already fixed.** `GET /api/uploads?q=` once ran the caller's regex as
 *   `DocModel.find({ title: rx })` with no workspace bound — an unindexed cross-tenant collection
 *   scan any signed-in caller could fire, whose 100-row cap could also be filled by foreign titles
 *   and push the caller's own matches out of their own listing. The route now carries the same
 *   tenancy rule as the upload filter beside it. `tests/lib/crossTenantScoping.test.ts` already
 *   covers that; the case here is a second pin, kept because this file is where the finding was
 *   answered and a regression should fail in both places.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";
import { NextResponse } from "next/server";

// --- L8: the realtime ticket key -----------------------------------------------------------------

const { realtimeSecret, signRealtimeTicket, verifyRealtimeTicket } = await import("@/lib/realtime/ticket");

const MASTER = "master-nextauth-secret-value-1234567890";
const DEDICATED = "a-distinct-realtime-secret-0987654321";

describe("realtimeSecret()", () => {
  const saved = {
    realtime: process.env.REALTIME_SECRET,
    nextauth: process.env.NEXTAUTH_SECRET,
  };

  afterEach(() => {
    if (saved.realtime === undefined) delete process.env.REALTIME_SECRET;
    else process.env.REALTIME_SECRET = saved.realtime;
    if (saved.nextauth === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = saved.nextauth;
  });

  test("the key is a function of the configured secret alone, not of the rest of the environment", () => {
    // The Vercel app holds both variables; the realtime and MCP hosts are told to hold only
    // REALTIME_SECRET. Same configured value, so the same key — otherwise every ticket the app
    // mints is rejected by the server that verifies it (close 4401) and realtime falls back to
    // polling with no configuration having changed.
    process.env.REALTIME_SECRET = DEDICATED;
    process.env.NEXTAUTH_SECRET = MASTER;
    const onTheApp = realtimeSecret();
    delete process.env.NEXTAUTH_SECRET;
    expect(realtimeSecret()).toBe(onTheApp);

    // And the case the old equality check broke: one string reused under both names.
    process.env.REALTIME_SECRET = MASTER;
    process.env.NEXTAUTH_SECRET = MASTER;
    const appWithACopy = realtimeSecret();
    delete process.env.NEXTAUTH_SECRET;
    expect(realtimeSecret()).toBe(appWithACopy);
  });

  test("a secret set for this purpose is still bound to this purpose, never used raw", () => {
    process.env.REALTIME_SECRET = DEDICATED;
    process.env.NEXTAUTH_SECRET = MASTER;
    const key = realtimeSecret();
    expect(key).not.toBe(DEDICATED);
    expect(key).not.toContain(DEDICATED);
    // It is still the configured secret that decides the key: change it and the key changes.
    process.env.REALTIME_SECRET = `${DEDICATED}-rotated`;
    expect(realtimeSecret()).not.toBe(key);
  });

  test("the NEXTAUTH_SECRET fallback never becomes the ticket key itself", () => {
    delete process.env.REALTIME_SECRET;
    process.env.NEXTAUTH_SECRET = MASTER;
    const key = realtimeSecret();
    expect(key).not.toBe(MASTER);
    expect(key).not.toContain(MASTER);
  });

  test("a ticket minted on the fallback does not verify against the raw master secret", () => {
    delete process.env.REALTIME_SECRET;
    process.env.NEXTAUTH_SECRET = MASTER;
    const { ticket } = signRealtimeTicket({ userId: "u1", orgId: "o1" });
    // The whole point: holding NEXTAUTH_SECRET must not be the same thing as holding the ticket key.
    expect(verifyRealtimeTicket(ticket, { secret: MASTER })).toBeNull();
    // And the deployment that legitimately derives the key still verifies its own tickets.
    expect(verifyRealtimeTicket(ticket)).toMatchObject({ userId: "u1", orgId: "o1" });
  });

  test("the derived key is stable, so separate deployments agree without coordinating", () => {
    delete process.env.REALTIME_SECRET;
    process.env.NEXTAUTH_SECRET = MASTER;
    const first = realtimeSecret();
    const second = realtimeSecret();
    expect(second).toBe(first);
  });

  test("one string reused under both variable names lands on one key, and never on the string", () => {
    process.env.NEXTAUTH_SECRET = MASTER;
    delete process.env.REALTIME_SECRET;
    const derived = realtimeSecret();
    process.env.REALTIME_SECRET = MASTER;
    expect(realtimeSecret()).toBe(derived);
    expect(realtimeSecret()).not.toBe(MASTER);
  });

  test("with neither secret configured it still fails loudly rather than signing with an empty key", () => {
    delete process.env.REALTIME_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(() => realtimeSecret()).toThrow(/REALTIME_SECRET/);
  });

  test("tampering and expiry are still rejected", () => {
    process.env.REALTIME_SECRET = DEDICATED;
    process.env.NEXTAUTH_SECRET = MASTER;
    const now = 1_700_000_000;
    const { ticket } = signRealtimeTicket({ userId: "u1", orgId: "o1" }, { now, ttlSeconds: 60 });
    expect(verifyRealtimeTicket(ticket, { now })).toMatchObject({ orgId: "o1" });
    expect(verifyRealtimeTicket(ticket, { now: now + 61 })).toBeNull();
    const [v, payload, sig] = ticket.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ u: "u1", o: "other-org", e: now + 60 })).toString("base64url");
    expect(verifyRealtimeTicket(`${v}.${forgedPayload}.${sig}`, { now })).toBeNull();
    expect(payload).not.toBe(forgedPayload);
  });
});

// --- L9: the `?q=` title lookup in the uploads listing -------------------------------------------

const TEAM_ORG = new Types.ObjectId().toString();
const PERSONAL_ORG = new Types.ObjectId().toString();
const ME = new Types.ObjectId().toString();
const DOC = new Types.ObjectId();

const resolveActor = vi.fn();
const docFind = vi.fn((_filter: Record<string, unknown>) => ({}) as unknown);
const uploadCountDocuments = vi.fn(async (_filter: Record<string, unknown>) => 0);
const uploadFind = vi.fn((_filter: Record<string, unknown>) => ({}) as unknown);

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
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: (...a: unknown[]) => (resolveActor as never as (...x: unknown[]) => unknown)(...a),
  applyTempUserHeaders: (res: unknown) => res,
  tryResolveUserActorFastWithPersonalOrg: vi.fn(async () => null),
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    find: (...a: unknown[]) => (docFind as never as (...x: unknown[]) => unknown)(...a),
    findOne: vi.fn(async () => null),
    findByIdAndUpdate: vi.fn(async () => null),
  },
  allocateDocUploadVersion: vi.fn(async () => 1),
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    countDocuments: (...a: unknown[]) => (uploadCountDocuments as never as (...x: unknown[]) => unknown)(...a),
    find: (...a: unknown[]) => (uploadFind as never as (...x: unknown[]) => unknown)(...a),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/gating/actorRateLimit", () => ({ actorRateLimitResponse: () => null }));
vi.mock("@/lib/gating/waitlist", () => ({ forbidWaitlisted: vi.fn(async () => null) }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));
vi.mock("@/lib/crypto/randomBase62", () => ({ newShareId: () => "MINTEDSLUG01", randomBase62: () => "aaaa" }));
vi.mock("@/lib/activity/log", () => ({ agentFromRequest: () => null, agentLabel: () => null, recordActivity: vi.fn() }));
vi.mock("@/lib/uploads/progress", () => ({
  uploadProgressFor: () => ({ percent: 0, stage: "created", stageKey: "created" }),
}));
vi.mock("@/lib/ai/agentSummary", () => ({
  INVALID_SUMMARY_CODE: "invalid_summary",
  parseAgentSummaryInput: () => ({ ok: true, value: null }),
}));
vi.mock("@/lib/blob/serverClientUploadRoute", () => ({
  isPdfUploadMeta: () => true,
  PDF_ONLY_ERROR_MESSAGE: "pdf only",
  UNSUPPORTED_FILE_TYPE_CODE: "unsupported_file_type",
}));
vi.mock("@/lib/http/errorResponse", () => ({
  errorJson: (err: unknown) => NextResponse.json({ error: String(err) }, { status: 400 }),
}));

const { GET: uploadsGET } = await import("@/app/api/uploads/route");

/** Walk a filter and report whether any branch of it pins `orgId`. */
function mentionsOrgId(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(mentionsOrgId);
  if (!node || typeof node !== "object") return false;
  return Object.entries(node as Record<string, unknown>).some(
    ([key, value]) => key === "orgId" || mentionsOrgId(value),
  );
}

describe("GET /api/uploads?q= — the title lookup carries a workspace bound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docFind.mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [{ _id: DOC }] }) }) });
    uploadCountDocuments.mockResolvedValue(0);
    uploadFind.mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) }),
    });
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: ME,
      orgId: TEAM_ORG,
      personalOrgId: PERSONAL_ORG,
    });
  });

  test("the search never scans documents outside the caller's workspace", async () => {
    await uploadsGET(new Request("http://localhost/api/uploads?q=deck"));
    expect(docFind).toHaveBeenCalledTimes(1);
    const filter = docFind.mock.calls[0]![0] as Record<string, unknown>;
    // `{ title: rx }` alone is a cross-tenant COLLSCAN and a 100-row cap other tenants can fill.
    expect(mentionsOrgId(filter)).toBe(true);
    expect(Object.keys(filter)).not.toEqual(["title"]);
  });

  test("a personal workspace may still reach its own pre-workspace rows, but only by its own userId", async () => {
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: ME,
      orgId: PERSONAL_ORG,
      personalOrgId: PERSONAL_ORG,
    });
    await uploadsGET(new Request("http://localhost/api/uploads?q=deck"));
    const filter = docFind.mock.calls[0]![0] as Record<string, unknown>;
    expect(mentionsOrgId(filter)).toBe(true);
    // The legacy concession is scoped to the caller, not opened to everyone with a null orgId.
    expect(JSON.stringify(filter)).toContain(ME);
  });

  test("no search term means no document scan at all", async () => {
    await uploadsGET(new Request("http://localhost/api/uploads"));
    expect(docFind).not.toHaveBeenCalled();
  });
});
