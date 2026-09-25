/**
 * `POST /api/docs/:docId/links/:linkId/password/verify` — the owner-side "does this open my link?".
 *
 * Its whole value is agreeing with the recipient's unlock route, and it did not. The stored hash is
 * made from a trimmed password (`passwordFields`), and the unlock route trims what the recipient
 * types before comparing, but this route compared the raw request body. A pasted password that
 * carried a leading or trailing space — the ordinary way a password arrives in a paste — came back
 * `matches: false` for a string that opens the link, so an owner verifying what they had just sent
 * was told it was wrong and rotated a working link.
 *
 * These tests pin the agreement itself: the same candidate is put through both handlers and they
 * must reach the same verdict, which is the property that broke rather than the trim that fixes it.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import { hashSharePassword } from "@/lib/sharePassword";

const PASSWORD = "hunter2";
const { salt, hash } = hashSharePassword(PASSWORD);

const ORG_ID = "64b0c0ffee0000000000e001";
const USER_ID = "64b0c0ffee0000000000e002";
const DOC_ID = "64b0c0ffee0000000000e003";
const LINK_ID = "64b0c0ffee0000000000e004";

const { actor, listShareLinks, resolveShareLink } = vi.hoisted(() => ({
  actor: { kind: "user", userId: "64b0c0ffee0000000000e002", orgId: "64b0c0ffee0000000000e001" },
  listShareLinks: vi.fn(),
  resolveShareLink: vi.fn(),
}));

vi.mock("@/lib/gating/actor", () => ({
  applyTempUserHeaders: (res: Response) => res,
  tryResolveAuthUserId: vi.fn(async () => null),
}));
vi.mock("@/lib/http/rateLimit", () => ({
  rateLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })),
  rateLimitedResponse: vi.fn(),
  clientIpFromRequest: vi.fn(() => "203.0.113.7"),
}));
vi.mock("@/lib/share/links", () => ({ listShareLinks, resolveShareLink }));
// The route reads the one link by id now (review Low: no more loading the whole list to check
// one id); the rows the test feeds `listShareLinks` are the rows the model answers with.
vi.mock("@/lib/models/ShareLink", () => ({
  ShareLinkModel: {
    findOne: (filter: { _id?: unknown }) => ({
      lean: async () => {
        const rows = (await listShareLinks()) as Array<{ _id: unknown }>;
        return rows.find((r) => String(r._id) === String(filter._id)) ?? null;
      },
    }),
  },
}));
vi.mock("@/lib/share/projectLinks", () => ({ resolveProjectLink: vi.fn(async () => null) }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer: vi.fn(async () => true) }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/http/errorResponse", () => ({ errorJson: vi.fn() }));
vi.mock("@/app/api/docs/[docId]/links/shared", () => ({
  accessDocForLinks: vi.fn(async () => ({
    ok: true,
    access: { actor, docId: DOC_ID, orgId: ORG_ID },
  })),
  linkErrorResponse: vi.fn((err: unknown) => {
    throw err;
  }),
}));

const { POST: verifyPost } = await import("@/app/api/docs/[docId]/links/[linkId]/password/verify/route");
const { POST: unlockPost } = await import("@/app/api/share/[shareId]/unlock/route");

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Ask the owner-side route whether `candidate` opens the link. */
async function ownerSays(candidate: string) {
  const res = await verifyPost(jsonRequest("http://localhost/api/docs/d/links/l/password/verify", { password: candidate }), {
    params: Promise.resolve({ docId: DOC_ID, linkId: LINK_ID }),
  });
  return { status: res.status, body: (await res.json()) as { matches?: boolean; passwordEnabled?: boolean; error?: string } };
}

/** Ask the recipient-facing unlock route the same question. */
async function recipientSays(candidate: string) {
  const res = await unlockPost(jsonRequest("http://localhost/api/share/abc123/unlock", { password: candidate }), {
    params: Promise.resolve({ shareId: "abc123" }),
  });
  return { status: res.status, opened: res.status === 200 };
}

beforeEach(() => {
  listShareLinks.mockResolvedValue([
    { _id: LINK_ID, archivedAt: null, passwordSalt: salt, passwordHash: hash },
  ]);
  resolveShareLink.mockResolvedValue({
    refusal: null,
    link: { orgId: ORG_ID, docId: DOC_ID, createdByUserId: USER_ID, passwordSalt: salt, passwordHash: hash },
  });
});

describe("owner-side password verify", () => {
  test("the exact password matches", async () => {
    expect(await ownerSays(PASSWORD)).toMatchObject({ status: 200, body: { passwordEnabled: true, matches: true } });
  });

  test("a pasted password with surrounding whitespace matches, as it does for the recipient", async () => {
    const pasted = `  ${PASSWORD}\n`;
    expect(await recipientSays(pasted)).toEqual({ status: 200, opened: true });
    expect(await ownerSays(pasted)).toMatchObject({ status: 200, body: { matches: true } });
  });

  test("a genuinely wrong password still fails on both sides", async () => {
    expect(await recipientSays("hunter3")).toEqual({ status: 401, opened: false });
    expect(await ownerSays("hunter3")).toMatchObject({ status: 200, body: { passwordEnabled: true, matches: false } });
  });

  test("whitespace-only is nothing to check, the same 400 an empty body gets", async () => {
    expect((await ownerSays("   ")).status).toBe(400);
    expect((await ownerSays("")).status).toBe(400);
  });

  test("a link with no password never matches", async () => {
    listShareLinks.mockResolvedValue([{ _id: LINK_ID, archivedAt: null, passwordSalt: null, passwordHash: null }]);
    expect(await ownerSays(PASSWORD)).toMatchObject({ status: 200, body: { passwordEnabled: false, matches: false } });
  });
});
