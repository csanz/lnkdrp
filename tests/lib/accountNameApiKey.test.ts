/**
 * An `lnk_` key may not rename the account.
 *
 * `/api/users/me/name` resolved with `resolveActor`, which accepts an API key bearer, and then wrote
 * `User.name` with no `forbidApiKey`. The commit that swept account delete, workspace rename and
 * delete, member removal, invites and key minting ("an API key is a document capability, not a
 * second password") missed this route. Nothing here is read or destroyed, so the damage is small,
 * but the shape is the one the rule exists to stop: the key is pinned to one workspace and
 * `User.name` is the account row, so a key minted for workspace A rewrote the name that workspaces
 * B, C and D render in their member lists, that member.joined/removed activity rows copy in, and
 * that outgoing email signs.
 *
 * The signed-in path is pinned alongside it, because a guard that refuses everyone is not a fix.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const USER = new Types.ObjectId().toString();

const connectMongo = vi.fn(async () => undefined);
const updateOne = vi.fn(async (_filter: unknown, _update: unknown) => ({ matchedCount: 1 }));
const resolveActor = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/User", () => ({ UserModel: { updateOne } }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor }));

const { POST } = await import("@/app/api/users/me/name/route");

function nameRequest(body: unknown) {
  return new Request("http://localhost/api/users/me/name", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/users/me/name", () => {
  test("a key actor is refused, and nothing is written", async () => {
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: USER,
      orgId: new Types.ObjectId().toString(),
      viaApiKey: { keyId: "key_1", scopes: ["*"] },
    });

    const res = await POST(nameRequest({ firstName: "Someone", lastName: "Else" }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("api_key_forbidden");
    // The message names the action: an agent told only "forbidden" retries.
    expect(json.message).toContain("change your account name");
    expect(updateOne).not.toHaveBeenCalled();
  });

  test("the refusal comes before the body is read, so an empty POST is 403 and not 400", async () => {
    // This is how the gap was first spotted live: an empty body answered 400 "Missing firstName",
    // which only looks like a rejection. 400 means the key authenticated and the write was one
    // well-formed field away.
    resolveActor.mockResolvedValue({
      kind: "user",
      userId: USER,
      orgId: new Types.ObjectId().toString(),
      viaApiKey: { keyId: "key_1", scopes: ["*"] },
    });

    const res = await POST(nameRequest({}));
    expect(res.status).toBe(403);
    expect(updateOne).not.toHaveBeenCalled();
  });

  test("a signed-in person still renames themselves", async () => {
    resolveActor.mockResolvedValue({ kind: "user", userId: USER, orgId: new Types.ObjectId().toString() });

    const res = await POST(nameRequest({ firstName: "Ada", lastName: "Lovelace" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, name: "Ada Lovelace" });
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0][1]).toEqual({ $set: { name: "Ada Lovelace" } });
  });

  test("an anonymous caller is still 401, not 403", async () => {
    resolveActor.mockResolvedValue({ kind: "temp", orgId: new Types.ObjectId().toString() });

    const res = await POST(nameRequest({ firstName: "Ada" }));
    expect(res.status).toBe(401);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
