/**
 * Off route (`/api/notifications/views/off`): RFC 8058 one-click POST and the unchanged GET page.
 */
import { createEmailsOffToken, verifyAnyEmailsOffToken } from "@/lib/notifications/viewEmailToken";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { connectMongo, membershipUpdateOne, membershipFindOneAndUpdate, membershipFindOne, orgFindOne } = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  membershipUpdateOne: vi.fn(),
  membershipFindOneAndUpdate: vi.fn(),
  membershipFindOne: vi.fn(),
  orgFindOne: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { updateOne: membershipUpdateOne, findOneAndUpdate: membershipFindOneAndUpdate, findOne: membershipFindOne },
}));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: orgFindOne } }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));

const { GET, POST, HEAD } = await import("@/app/api/notifications/views/off/route");
const { createViewEmailsOffToken } = await import("@/lib/notifications/viewEmailToken");
const { VIEW_EMAIL_PREFERENCES_PATH } = await import("@/lib/notifications/viewNotifications");

const MEMBERSHIP = new Types.ObjectId().toString();
const ORG = new Types.ObjectId();

function lean(doc: unknown) {
  return { select: () => ({ lean: async () => doc }) };
}

function url(token: string) {
  return `https://lnkdrp.test/api/notifications/views/off?t=${encodeURIComponent(token)}`;
}

function oneClick(token: string, body = "List-Unsubscribe=One-Click", type = "application/x-www-form-urlencoded") {
  return new Request(url(token), { method: "POST", headers: { "content-type": type }, body });
}

beforeEach(() => {
  vi.clearAllMocks();
  membershipUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  membershipFindOneAndUpdate.mockReturnValue(lean({ orgId: ORG }));
  membershipFindOne.mockReturnValue(lean({ orgId: ORG, viewEmailMode: "off" }));
  orgFindOne.mockReturnValue(lean({ name: "Personal" }));
});

describe("POST one-click unsubscribe (RFC 8058)", () => {
  test("form-encoded List-Unsubscribe=One-Click with the query token sets off and returns 200 with no page", async () => {
    const res = await POST(oneClick(createViewEmailsOffToken(MEMBERSHIP)));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(membershipUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = membershipUpdateOne.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(String(filter._id)).toBe(MEMBERSHIP);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(update).toEqual({ $set: { viewEmailMode: "off" } });
  });

  test("idempotent: a second POST on an already-off membership is still 200", async () => {
    const token = createViewEmailsOffToken(MEMBERSHIP);
    expect((await POST(oneClick(token))).status).toBe(200);
    membershipUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 0 });
    expect((await POST(oneClick(token))).status).toBe(200);
    expect(membershipUpdateOne).toHaveBeenCalledTimes(2);
  });

  test("multipart/form-data body is accepted too", async () => {
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const res = await POST(new Request(url(createViewEmailsOffToken(MEMBERSHIP)), { method: "POST", body: form }));
    expect(res.status).toBe(200);
    expect(membershipUpdateOne).toHaveBeenCalledTimes(1);
  });

  test("a POST without the one-click body changes nothing", async () => {
    const token = createViewEmailsOffToken(MEMBERSHIP);
    for (const req of [oneClick(token, ""), oneClick(token, "List-Unsubscribe=Other"), oneClick(token, "{}", "application/json")]) {
      expect((await POST(req)).status).toBe(400);
    }
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });

  test("forged, malformed or expired tokens change nothing", async () => {
    const good = createViewEmailsOffToken(MEMBERSHIP);
    const forged = `${good.split(".")[0]}.AAAA`;
    const expired = createViewEmailsOffToken(MEMBERSHIP, { now: new Date(Date.now() - 40 * 24 * 3600_000) });
    for (const t of [forged, "nope", "", expired]) expect((await POST(oneClick(t))).status).toBe(400);
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });

  test("a membership deleted since the email went out is 400", async () => {
    membershipUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    expect((await POST(oneClick(createViewEmailsOffToken(MEMBERSHIP)))).status).toBe(400);
  });
});

describe("GET stays a confirmation page", () => {
  test("a valid token renders a button and changes nothing until it is pressed", async () => {
    // A member who still gets these emails — the case where there is something to turn off.
    membershipFindOne.mockReturnValue(lean({ orgId: ORG, viewEmailMode: "immediate" }));
    const res = await GET(new Request(url(createViewEmailsOffToken(MEMBERSHIP))));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<form method=\"post\"");
    expect(html).toContain(`href="${VIEW_EMAIL_PREFERENCES_PATH}"`);
    expect(VIEW_EMAIL_PREFERENCES_PATH).toBe("/dashboard?tab=notifications#email-preferences");
    // The old path is baked into every email already sent, so the anchor it points at has to keep
    // existing on the Account tab — as a signpost, not as the settings themselves.
    const dash = fs.readFileSync(path.resolve(__dirname, "../../src/app/dashboard/page.tsx"), "utf8");
    expect(dash).toContain('id="email-preferences"');

    /**
     * This test used to assert the opposite — that a GET wrote `viewEmailMode: "off"` on sight of
     * the token, and it asserted `membershipFindOneAndUpdate` had been called once. That was the
     * bug, not the contract. The unsubscribe URL is printed in the visible footer of every view
     * email, so any link scanner, security proxy or client prefetch that fetches the links in a
     * message silently switched a member's notifications off — and the token is a bearer with no
     * revocation, so the member could not tell what had happened or stop it happening again.
     *
     * The write now lives only on POST, which is also where the mail provider's RFC 8058
     * one-click unsubscribe already sent it, so the human path and the provider path share one
     * write path instead of two.
     */
    expect(membershipFindOneAndUpdate).not.toHaveBeenCalled();
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });

  test("a member who is already unsubscribed is told so, with nothing to press", async () => {
    const res = await GET(new Request(url(createViewEmailsOffToken(MEMBERSHIP))));
    const html = await res.text();
    expect(html).toContain("View emails are off");
    expect(html).not.toContain("<form method=\"post\"");
    expect(membershipFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("HEAD never writes", async () => {
    const res = await HEAD(new Request(url(createViewEmailsOffToken(MEMBERSHIP)), { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(membershipFindOneAndUpdate).not.toHaveBeenCalled();
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });
});

describe("a doc-update unsubscribe link is about doc-update emails", () => {
  /**
   * The write path was made kind-aware when doc-update mail got its own token; the page that
   * renders around it was not, and kept reading `viewEmailMode` whatever the token said. Two
   * wrong pages came out of that: one describing view emails while its button wrote the
   * doc-update field, and — for a member who already had view emails off — a dead end with no
   * button at all, so the mail they were trying to stop kept arriving.
   */
  test("an expired doc-update token reads as expired, not as a bad signature", () => {
    const token = createEmailsOffToken("doc_updates", "m1", {
      now: new Date("2026-01-01T00:00:00Z"),
      ttlMs: 1000,
    });
    const res = verifyAnyEmailsOffToken(token, { now: new Date("2026-02-01T00:00:00Z") });
    expect(res.ok).toBe(false);
    // Each kind is tried in turn and a doc-update token fails the view check at the signature,
    // so the first failure seen is bad_signature — which renders "this link is not valid".
    expect(!res.ok && res.reason).toBe("expired");
  });

  test("a live doc-update token names its own kind", () => {
    const token = createEmailsOffToken("doc_updates", "m1", { now: new Date("2026-01-01T00:00:00Z") });
    const res = verifyAnyEmailsOffToken(token, { now: new Date("2026-01-02T00:00:00Z") });
    expect(res.ok && res.kind).toBe("doc_updates");
  });

  test("a view token still verifies as views, since those links are already in mailboxes", () => {
    const token = createEmailsOffToken("views", "m1", { now: new Date("2026-01-01T00:00:00Z") });
    const res = verifyAnyEmailsOffToken(token, { now: new Date("2026-01-02T00:00:00Z") });
    expect(res.ok && res.kind).toBe("views");
  });

  /**
   * The expired branch was the last render site still holding a literal. The field read was made
   * kind-aware; the heading over it was not, so a month-old doc-update link whose mail was already
   * off rendered "View emails are off" above "Document update emails are already off for Personal" —
   * the reader is told a setting they never touched is off, on the one page in the product where
   * somebody is asking us to stop emailing them.
   */
  test("an expired doc-update link is headed by the doc-update setting, never by view emails", async () => {
    membershipFindOne.mockReturnValue(lean({ orgId: ORG, docUpdateEmailMode: "off" }));
    const expired = createEmailsOffToken("doc_updates", MEMBERSHIP, { now: new Date(Date.now() - 40 * 24 * 3600_000) });

    const res = await GET(new Request(url(expired)));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Document update emails are off");
    expect(html).toContain("Document update emails are already off for");
    expect(html).not.toContain("View emails");
    // Reporting a state is all this branch does; nothing is written on an expired link.
    expect(membershipFindOneAndUpdate).not.toHaveBeenCalled();
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });

  test("an expired view link still says view emails, since that copy was right all along", async () => {
    membershipFindOne.mockReturnValue(lean({ orgId: ORG, viewEmailMode: "off" }));
    const expired = createViewEmailsOffToken(MEMBERSHIP, { now: new Date(Date.now() - 40 * 24 * 3600_000) });

    const html = await (await GET(new Request(url(expired)))).text();
    expect(html).toContain("View emails are off");
    expect(html).not.toContain("Document update emails");
  });

  test("an expired link for mail that is still arriving names no setting in its heading", async () => {
    membershipFindOne.mockReturnValue(lean({ orgId: ORG, docUpdateEmailMode: "immediate" }));
    const expired = createEmailsOffToken("doc_updates", MEMBERSHIP, { now: new Date(Date.now() - 40 * 24 * 3600_000) });

    const html = await (await GET(new Request(url(expired)))).text();
    expect(html).toContain("This link has expired");
    expect(html).toContain("Document update emails arrive immediately");
    expect(html).not.toContain("View emails");
  });

  test("the page reads the field the token names, and offers a button for it", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/app/api/notifications/views/off/route.ts"),
      "utf8",
    );
    // The read-only branch must not hardcode viewEmailMode; that is what made it a dead end.
    expect(src).not.toMatch(/select\(\{ orgId: 1, viewEmailMode: 1 \}\)/);
    expect(src).toContain("EMAIL_OFF_KINDS[kind].field");
    expect(src).toContain("copy.confirmLabel");
  });
});
