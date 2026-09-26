/**
 * `GET /api/activity/actor` - the contributor page's header endpoint.
 *
 * The route is thin on purpose (`loadActorProfile` does the work and is tested in
 * `tests/lib/actorProfile.test.ts`), so what is worth pinning here is the four answers and the
 * order they are decided in:
 *
 * - A key that is not a key is a 400, decided before the database is touched.
 * - A caller who is not a member of the active workspace is a 403, decided before the profile is
 *   loaded, so the endpoint cannot be used to ask questions about a workspace you left.
 * - "No rows for this contributor here" is a 404 and not an empty 200, because that emptiness *is*
 *   the tenancy check: a 200 would turn `/people/<any 24 hex>` into a membership oracle for every
 *   other workspace on the platform.
 * - The org the profile is loaded for is always the session's active org, never anything the
 *   caller passed.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

import type { ActorProfile } from "@/lib/people/types";

const ALICE = "6ab46f3a542dc85d9d3ba00f";
const ORG = "6ab46f3add6983534677900a";
const OTHER_ORG = "6ab46f3add69835346779222";

const resolveActor = vi.fn(async () => ({ kind: "user", userId: ALICE, orgId: ORG, personalOrgId: ORG }));
const applyTempUserHeaders = vi.fn((res: Response) => res);
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));

let role: "owner" | "viewer" | "none" = "viewer";
const requireOrgRole = vi.fn(async () =>
  role === "none" ? { ok: false as const, status: 403 as const, error: "Forbidden" } : { ok: true as const, role },
);
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole }));

const connectMongo = vi.fn(async () => undefined);
vi.mock("@/lib/mongodb", () => ({ connectMongo }));

/** What the mocked loader answers; null is "this contributor has nothing here". */
let profile: ActorProfile | null = null;
const loadActorProfile = vi.fn(async (_params: { orgId: Types.ObjectId; key: unknown }) => profile);
vi.mock("@/lib/people/profile", () => ({ loadActorProfile }));

const { GET } = await import("@/app/api/activity/actor/route");

/** A person's profile, complete enough that the route can only pass it through or mangle it. */
function personProfile(): ActorProfile {
  return {
    key: `user:${ALICE}`,
    kind: "person",
    name: "Christian Sanz",
    email: "christian@lnkdrp.com",
    client: null,
    owner: null,
    firstAt: "2026-03-01T00:00:00.000Z",
    lastAt: "2026-09-20T10:00:00.000Z",
    totalActions: 94,
    workActions: 92,
    buckets: { docsAdded: 0, docsReplaced: 3, linksCreated: 40, docsRemoved: 1, projectsCreated: 4 },
    byType: [{ type: "share.created", count: 40 }],
    docs: [{ id: "6ab46f3add69835346779111", title: "Series A deck", deleted: false, actions: 12, lastAt: "2026-09-20T10:00:00.000Z", href: "/doc/6ab46f3add69835346779111" }],
    projects: [],
    agents: [
      {
        key: `agent:claude-code@${ALICE}`,
        client: "claude-code",
        label: "Claude Code",
        actions: 450,
        lastAt: "2026-09-21T10:00:00.000Z",
        href: `/agents/claude-code/${ALICE}`,
      },
    ],
    href: `/people/${ALICE}`,
  };
}

function get(query: string) {
  return GET(new Request(`http://localhost/api/activity/actor${query}`));
}

beforeEach(() => {
  role = "viewer";
  profile = personProfile();
  loadActorProfile.mockClear();
  connectMongo.mockClear();
  resolveActor.mockClear();
});

describe("a key that is not a key", () => {
  test.each(["", "bogus", "user:abc", "agent:Claude Code@" + ALICE, "agent:claude-code@notanid", "6ab46f3a542dc85d9d3ba00f"])(
    "%s answers 400 without asking the database anything",
    async (bad) => {
      const res = await get(`?key=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid key. Pass user:<userId> or agent:<client>@<ownerUserId>.");
      expect(loadActorProfile).not.toHaveBeenCalled();
      expect(connectMongo).not.toHaveBeenCalled();
    },
  );

  test("a missing key parameter is the same answer", async () => {
    expect((await get("")).status).toBe(400);
  });
});

describe("who may ask", () => {
  test("a non-member is refused before the profile is loaded", async () => {
    role = "none";
    const res = await get(`?key=user:${ALICE}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(loadActorProfile).not.toHaveBeenCalled();
  });

  test("a viewer may: this is the same record the feed already shows them", async () => {
    role = "viewer";
    expect((await get(`?key=user:${ALICE}`)).status).toBe(200);
  });

  test("a temp user gets the 404, not a 401 and not somebody's profile", async () => {
    resolveActor.mockResolvedValueOnce({ kind: "temp", userId: "t1", orgId: ORG, personalOrgId: ORG } as never);
    const res = await get(`?key=user:${ALICE}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No activity for this actor in this workspace.");
    expect(loadActorProfile).not.toHaveBeenCalled();
  });
});

describe("what comes back", () => {
  test("a profile is passed through whole, uncached", async () => {
    const res = await get(`?key=user:${ALICE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(personProfile());
  });

  test("an agent key reaches the loader parsed, owner and all", async () => {
    profile = { ...personProfile(), kind: "agent", key: `agent:claude-code@${ALICE}`, client: "claude-code", agents: [] };
    const res = await get(`?key=agent:claude-code@${ALICE}`);
    expect(res.status).toBe(200);
    expect(loadActorProfile).toHaveBeenCalledWith({
      orgId: new Types.ObjectId(ORG),
      key: { kind: "agent", client: "claude-code", ownerUserId: ALICE },
      // The reader, because the page names rooms and a locked one is not theirs to see
      // (docs/prds/lnkdrp-locked-projects.md, decision 14).
      viewerUserId: ALICE,
    });
  });

  test("a legacy agent:<client> key resolves to the unknown owner", async () => {
    await get("?key=agent:claude-code");
    expect(loadActorProfile).toHaveBeenCalledWith(
      expect.objectContaining({ key: { kind: "agent", client: "claude-code", ownerUserId: null } }),
    );
  });

  test("nothing by this contributor here is a 404, not an empty 200", async () => {
    profile = null;
    const res = await get("?key=user:000000000000000000000000");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No activity for this actor in this workspace.");
  });

  test("the workspace asked about is always the session's active org", async () => {
    resolveActor.mockResolvedValueOnce({ kind: "user", userId: ALICE, orgId: ORG, personalOrgId: OTHER_ORG } as never);
    // The query string names another workspace; the route must not read it.
    await get(`?key=user:${ALICE}&orgId=${OTHER_ORG}`);
    expect(String(loadActorProfile.mock.calls[0][0].orgId)).toBe(ORG);
  });
});
