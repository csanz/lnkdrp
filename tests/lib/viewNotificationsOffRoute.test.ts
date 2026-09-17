/**
 * Off route (`/api/notifications/views/off`): RFC 8058 one-click POST and the unchanged GET page.
 */
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
  test("valid token sets off and renders the page with the preferences link to the anchor", async () => {
    const res = await GET(new Request(url(createViewEmailsOffToken(MEMBERSHIP))));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("View emails are off");
    expect(html).toContain(`href="${VIEW_EMAIL_PREFERENCES_PATH}"`);
    expect(VIEW_EMAIL_PREFERENCES_PATH).toBe("/dashboard?tab=account#email-preferences");
    expect(membershipFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });

  test("HEAD never writes", async () => {
    const res = await HEAD(new Request(url(createViewEmailsOffToken(MEMBERSHIP)), { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(membershipFindOneAndUpdate).not.toHaveBeenCalled();
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });
});
