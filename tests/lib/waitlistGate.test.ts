/**
 * The early-access queue has to hold at the API, not only at the page shell.
 *
 * `src/app/(app)/layout.tsx` redirected a queued visitor to `/waitlist` and that was the entire
 * enforcement. The redirect decides what a browser renders; it decides nothing about what an
 * account may do. The same NextAuth cookie reaches `/api/*`, `resolveActor` never read
 * `accessStatus`, `forbidUnlessOrgRole` passes because a queued person owns their own personal
 * workspace, and there is no middleware — so `POST /api/docs`, `POST /api/uploads` and
 * `POST /api/uploads/:id/process?quality=advanced` answered a queued account normally and spent
 * the operator's AI budget on documents the operator had not agreed to admit.
 *
 * These pin the gate that closes it, and — because the failure was two surfaces disagreeing — that
 * the layout and the gate now read the same thing.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Types } from "mongoose";

import type { Actor } from "@/lib/gating/actor";

const ROOT = path.resolve(__dirname, "../..");

/** What the user row lookup will answer, per user id. */
const rows = new Map<string, { accessStatus?: unknown; role?: unknown } | null>();
let findOneCalls = 0;
let findOneThrows = false;

const connectMongo = vi.fn(async () => undefined);
vi.mock("@/lib/mongodb", () => ({ connectMongo: () => connectMongo() }));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    findOne: (filter: { _id: Types.ObjectId }) => {
      findOneCalls += 1;
      if (findOneThrows) throw new Error("mongo is having a moment");
      const row = rows.get(String(filter._id)) ?? null;
      return { select: () => ({ lean: async () => row }) };
    },
  },
}));

import { accessStatusChanged, forbidWaitlisted, isWaitlistedActor, readAccessStatus } from "@/lib/gating/waitlist";

function newUserId(): string {
  return new Types.ObjectId().toString();
}

function userActor(userId: string, extra?: Partial<Extract<Actor, { kind: "user" }>>): Actor {
  return {
    kind: "user",
    userId,
    orgId: new Types.ObjectId().toString(),
    personalOrgId: new Types.ObjectId().toString(),
    ...extra,
  };
}

beforeEach(() => {
  rows.clear();
  findOneCalls = 0;
  findOneThrows = false;
  connectMongo.mockClear();
});

describe("the gate a mutating route calls", () => {
  test("a queued account is refused, and told which action and where to go", async () => {
    const userId = newUserId();
    rows.set(userId, { accessStatus: "waitlisted" });

    const res = await forbidWaitlisted(userActor(userId), "upload a document");
    expect(res, "a queued account must not reach a mutating endpoint").not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string; redirectTo: string; message: string };
    expect(body.error).toBe("WAITLISTED");
    expect(body.redirectTo).toBe("/waitlist");
    expect(body.message).toContain("upload a document");
    expect(res!.headers.get("cache-control")).toBe("no-store");
  });

  test("an approved account is waved through", async () => {
    const userId = newUserId();
    rows.set(userId, { accessStatus: "approved" });
    expect(await forbidWaitlisted(userActor(userId), "upload a document")).toBeNull();
  });

  test("an account that predates the queue has no status and is waved through", async () => {
    const userId = newUserId();
    rows.set(userId, {});
    expect(await forbidWaitlisted(userActor(userId), "upload a document")).toBeNull();
  });

  test("an admin is never held at the door, whatever the row says", async () => {
    const userId = newUserId();
    rows.set(userId, { accessStatus: "waitlisted", role: "admin" });
    // The decision is `accessStatusOf`'s, not a second copy of the rules living in the gate.
    expect(await forbidWaitlisted(userActor(userId), "delete a workspace")).toBeNull();
  });

  test("a queued person's API key stops at the same door their browser does", async () => {
    const userId = newUserId();
    rows.set(userId, { accessStatus: "waitlisted" });
    const actor = userActor(userId, { viaApiKey: { keyId: "k1", scopes: ["docs:write"] } });
    const res = await forbidWaitlisted(actor, "create a link");
    expect(res, "a key carries its owner's queue status, not an exemption from it").not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("a temp actor is not in the queue — there is no account to approve", async () => {
    const actor: Actor = {
      kind: "temp",
      userId: newUserId(),
      orgId: new Types.ObjectId().toString(),
      personalOrgId: new Types.ObjectId().toString(),
      temp: { id: "t1" },
      isNew: true,
    };
    expect(await forbidWaitlisted(actor, "upload a document")).toBeNull();
    expect(findOneCalls, "a temp actor should not cost a user lookup").toBe(0);
  });

  test("an unusable id is not a lookup and not a refusal", async () => {
    expect(await readAccessStatus("not-an-object-id")).toBe("approved");
    expect(findOneCalls).toBe(0);
  });
});

describe("the read behind it", () => {
  test("a burst of API calls costs one lookup, and approving clears it", async () => {
    const userId = newUserId();
    rows.set(userId, { accessStatus: "waitlisted" });

    expect(await isWaitlistedActor(userActor(userId))).toBe(true);
    expect(await isWaitlistedActor(userActor(userId))).toBe(true);
    expect(findOneCalls, "the second call in the same page load should be cached").toBe(1);

    // An admin approves. Without the invalidation the person waits out the TTL staring at a screen
    // that says they are in.
    rows.set(userId, { accessStatus: "approved" });
    accessStatusChanged(userId);
    expect(await isWaitlistedActor(userActor(userId))).toBe(false);
    expect(findOneCalls).toBe(2);
  });

  test("a database blip lets people through rather than locking the product", async () => {
    const userId = newUserId();
    rows.set(userId, { accessStatus: "waitlisted" });
    findOneThrows = true;
    // Fail open, deliberately: the queue is off for most deployments and empty for every account
    // that predates it, so refusing every mutation during a blip would cost far more than one
    // queued request slipping past.
    expect(await readAccessStatus(userId)).toBe("approved");
    findOneThrows = false;
    // And the blip is not cached, so the next call still asks.
    expect(await readAccessStatus(userId)).toBe("waitlisted");
  });
});

describe("the page shell and the gate answer from one place", () => {
  test("the app layout reads the shared gate instead of its own status query", () => {
    const layout = fs.readFileSync(path.join(ROOT, "src/app/(app)/layout.tsx"), "utf8");
    // The original bug was one surface holding the only copy of the decision. If the layout goes
    // back to reading `accessStatus` for itself, the two can drift apart again silently.
    expect(layout, "the layout must decide from @/lib/gating/waitlist").toContain(
      'from "@/lib/gating/waitlist"',
    );
    expect(layout).toMatch(/readAccessStatus\(userId\)/);
    expect(layout).toContain('redirect("/waitlist")');
  });
});
