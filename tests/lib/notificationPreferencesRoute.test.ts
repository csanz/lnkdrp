import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();

const connectMongo = vi.fn(async () => undefined);
const findOne = vi.fn();
const updateOne = vi.fn();
const tryResolveUserActorFast = vi.fn();
const resolveActor = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { findOne, updateOne } }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveUserActorFast, resolveActor }));

const { GET, POST, PATCH } = await import("@/app/api/orgs/active/notification-preferences/route");

function leanResult(doc: unknown) {
  return { select: () => ({ lean: async () => doc }) };
}

function jsonRequest(method: string, body: unknown) {
  return new Request("http://localhost/api/orgs/active/notification-preferences", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tryResolveUserActorFast.mockResolvedValue({ kind: "user", orgId: ORG, userId: USER });
  updateOne.mockResolvedValue({ matchedCount: 1 });
});

describe("GET notification preferences", () => {
  test("returns viewEmailMode beside the two existing modes", async () => {
    findOne.mockReturnValue(
      leanResult({ viewEmailMode: "immediate", docUpdateEmailMode: "off", repoLinkRequestEmailMode: "daily" }),
    );
    const res = await GET(new Request("http://localhost/x"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.viewEmailMode).toBe("immediate");
    expect(json.docUpdateEmailMode).toBe("off");
    expect(json.repoLinkRequestEmailMode).toBe("daily");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a membership that predates the field reads as daily", async () => {
    findOne.mockReturnValue(leanResult({}));
    const json = await (await GET(new Request("http://localhost/x"))).json();
    expect(json.viewEmailMode).toBe("daily");
    expect(json.docUpdateEmailMode).toBe("daily");
    expect(json.repoLinkRequestEmailMode).toBe("daily");
  });

  test("an off member stays off (never re-defaulted on read)", async () => {
    findOne.mockReturnValue(leanResult({ viewEmailMode: "off" }));
    const json = await (await GET(new Request("http://localhost/x"))).json();
    expect(json.viewEmailMode).toBe("off");
  });

  test("requires a signed-in user", async () => {
    tryResolveUserActorFast.mockResolvedValue(null);
    resolveActor.mockResolvedValue({ kind: "temp", orgId: ORG });
    const res = await GET(new Request("http://localhost/x"));
    expect(res.status).toBe(401);
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("PATCH/POST notification preferences", () => {
  test.each([
    ["PATCH", PATCH],
    ["POST", POST],
  ])("%s sets viewEmailMode on the caller's own membership", async (method, handler) => {
    const res = await handler(jsonRequest(method, { viewEmailMode: "off" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, viewEmailMode: "off" });
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(String(filter.orgId)).toBe(ORG);
    expect(String(filter.userId)).toBe(USER);
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(update.$set.viewEmailMode).toBe("off");
    expect(update.$set).not.toHaveProperty("docUpdateEmailMode");
    expect(update.$set).not.toHaveProperty("repoLinkRequestEmailMode");
  });

  test("normalises the immediately alias like the other modes", async () => {
    const res = await PATCH(jsonRequest("PATCH", { viewEmailMode: "immediately", docUpdateEmailMode: "daily" }));
    expect(await res.json()).toEqual({ ok: true, viewEmailMode: "immediate", docUpdateEmailMode: "daily" });
  });

  test("rejects an unknown viewEmailMode without writing", async () => {
    const res = await PATCH(jsonRequest("PATCH", { viewEmailMode: "weekly" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid viewEmailMode");
    expect(updateOne).not.toHaveBeenCalled();
  });

  test("ignores unrelated fields and requires at least one mode", async () => {
    const res = await PATCH(jsonRequest("PATCH", { role: "owner", isDeleted: true }));
    expect(res.status).toBe(400);
    expect(updateOne).not.toHaveBeenCalled();
  });

  test("404 when the caller has no membership", async () => {
    updateOne.mockResolvedValue({ matchedCount: 0 });
    const res = await PATCH(jsonRequest("PATCH", { viewEmailMode: "daily" }));
    expect(res.status).toBe(404);
  });
});
