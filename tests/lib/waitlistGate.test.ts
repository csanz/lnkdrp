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
  test("an approved account's burst of API calls costs one lookup", async () => {
    // The case the cache exists for. An approved account is the one that generates a page's worth
    // of parallel API calls, and they should cost a single `_id` read between them.
    const userId = newUserId();
    rows.set(userId, { accessStatus: "approved" });

    expect(await isWaitlistedActor(userActor(userId))).toBe(false);
    expect(await isWaitlistedActor(userActor(userId))).toBe(false);
    expect(findOneCalls, "the second call in the same page load should be cached").toBe(1);
  });

  test("a queued account is re-read every time, on purpose", async () => {
    /**
     * The permissive answer is cached; the restrictive one is not, and this is the test that says
     * so deliberately rather than by accident.
     *
     * Caching "waitlisted" spared nothing worth sparing — `forbidWaitlisted` guards only mutating
     * endpoints, so a queued account's "burst" is a burst of refusals — and it cost two things on
     * the one screen where being let in is the whole product:
     *
     *   1. An admin clicks Approve and the account stays locked out for the rest of the TTL.
     *   2. Worse, it looped. `/waitlist` reads Mongo directly, saw "approved" and redirected to
     *      `/`, which still had "waitlisted" cached and redirected back, until the browser gave up
     *      with ERR_TOO_MANY_REDIRECTS. `accessStatusChanged` could not fix that: the cache is per
     *      process, and a dev server or a multi-instance deploy answers the two requests from
     *      different ones.
     */
    const userId = newUserId();
    rows.set(userId, { accessStatus: "waitlisted" });

    expect(await isWaitlistedActor(userActor(userId))).toBe(true);
    expect(await isWaitlistedActor(userActor(userId))).toBe(true);
    expect(findOneCalls, "a queued account must not be answered from a stale cache").toBe(2);

    // So approval is visible on the very next request, with no invalidation call and no TTL to
    // wait out — which is what makes it work across processes too.
    rows.set(userId, { accessStatus: "approved" });
    expect(await isWaitlistedActor(userActor(userId))).toBe(false);
  });

  test("approving still drops the cached permissive answer", async () => {
    // `accessStatusChanged` is now only load-bearing in the other direction, but it is still the
    // right call to make after any status write.
    const userId = newUserId();
    rows.set(userId, { accessStatus: "approved" });

    expect(await isWaitlistedActor(userActor(userId))).toBe(false);
    expect(findOneCalls).toBe(1);

    rows.set(userId, { accessStatus: "waitlisted" });
    accessStatusChanged(userId);
    expect(await isWaitlistedActor(userActor(userId))).toBe(true);
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
  test("every authenticated entry point runs the shared gate", () => {
    // The original bug was one surface holding the only copy of the decision. The second bug was
    // the opposite: a surface holding *no* copy. `src/app/page.tsx` is outside the `(app)` route
    // group, so the layout never ran for it — and `/` is where sign-in lands you, so a queued
    // visitor got the app home and a new account never saw `/welcome`. Both entry points now call
    // one function, and this pins that neither drifts back to deciding for itself.
    const gate = fs.readFileSync(path.join(ROOT, "src/lib/gating/entryGate.ts"), "utf8");
    expect(gate, "the gate must decide from @/lib/gating/waitlist").toContain('from "@/lib/gating/waitlist"');
    expect(gate).toMatch(/readAccessStatus\(userId\)/);
    expect(gate).toContain('redirect("/waitlist")');

    for (const entry of ["src/app/(app)/layout.tsx", "src/app/page.tsx"]) {
      const src = fs.readFileSync(path.join(ROOT, entry), "utf8");
      expect(src, `${entry} must run enforceEntryGates`).toContain("enforceEntryGates");
    }
  });
});
