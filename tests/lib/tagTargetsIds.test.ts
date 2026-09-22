/**
 * `/api/tags/targets` and the ids it is handed.
 *
 * The sidebar sends whatever ids its cached rows carry, and the route passes them to
 * `tagsForTargets`, which coerces every one with `new Types.ObjectId(...)`. That throws on anything
 * that is not an id, so one bad entry used to answer 500 and take the tags for the good ids in the
 * same request with it. The route's own header promises the opposite: an id the workspace does not
 * know returns nothing, not an error. These tests hold the route to that.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();
const DOC_A = new Types.ObjectId().toString();
const DOC_B = new Types.ObjectId().toString();

const resolveActor = vi.fn();
const applyTempUserHeaders = vi.fn((res: Response) => res);

/**
 * Stands in for the real service, including the part that matters: it coerces the ids it is given
 * exactly as `tagsForTargets` does, so an id the route failed to filter throws here just as it
 * would against Mongo.
 */
const tagsForTargets = vi.fn(async (params: { targetIds: ReadonlyArray<string> }) => {
  const ids = params.targetIds.map((id) => new Types.ObjectId(id));
  return new Map(ids.map((id) => [String(id), [{ id: "t1", name: "Fundraising" }]]));
});

vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));
vi.mock("@/lib/tags/service", () => ({ tagsForTargets }));

const { GET } = await import("@/app/api/tags/targets/route");

function get(ids: string) {
  return GET(new Request(`http://localhost/api/tags/targets?targetKind=doc&ids=${ids}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveActor.mockResolvedValue({ kind: "user", orgId: ORG, userId: USER });
});

describe("GET /api/tags/targets", () => {
  test("a malformed id is skipped and the valid ids in the same request keep their tags", async () => {
    const res = await get(`${DOC_A},nope,${DOC_B}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(Object.keys(json.tags).sort()).toEqual([DOC_A, DOC_B].sort());
    expect(tagsForTargets.mock.calls[0][0].targetIds).toEqual([DOC_A, DOC_B]);
  });

  test("a list of nothing but junk answers an empty map rather than an error", async () => {
    const res = await get("nope,../../etc/passwd,%20");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tags: {} });
    expect(tagsForTargets).not.toHaveBeenCalled();
  });

  test("the 200-id cap is spent on real ids, not on junk", async () => {
    const real = Array.from({ length: 200 }, () => new Types.ObjectId().toString());
    await get(["nope", "also-nope", ...real].join(","));
    expect(tagsForTargets.mock.calls[0][0].targetIds).toEqual(real);
  });

  test("only a signed-in user reads them", async () => {
    resolveActor.mockResolvedValue({ kind: "temp", orgId: ORG });
    const res = await get(DOC_A);
    expect(res.status).toBe(401);
    expect(tagsForTargets).not.toHaveBeenCalled();
  });
});
