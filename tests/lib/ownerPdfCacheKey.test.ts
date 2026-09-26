/**
 * The owner PDF route's cache key must name the bytes it caches.
 *
 * The page versions the URL with `?v=<currentUploadId>`, and the upload route points the document
 * at a new upload before processing has written that upload's blob. During those seconds the
 * route used to redirect `?v=<new id>` to the previous version's blob with a one-year immutable
 * header, and the browser kept it: the header said v3, the compare showed v3, the viewer showed
 * v2 (found on the Slack routing test, 2026-09-25).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, test, vi } from "vitest";

const DOC = new Types.ObjectId();
const ORG = new Types.ObjectId();
const ME = new Types.ObjectId();
const V2 = new Types.ObjectId();
const V3 = new Types.ObjectId();
const OLD_BLOB = "https://store.public.blob.vercel-storage.com/v2.pdf";
const NEW_BLOB = "https://store.public.blob.vercel-storage.com/v3.pdf";

const state = vi.hoisted(() => ({ uploads: new Map<string, { blobUrl?: string }>() }));

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
  resolveActor: vi.fn(async () => ({ kind: "user", userId: ME.toString(), orgId: ORG.toString(), personalOrgId: ORG.toString() })),
  tryResolveUserActorFast: vi.fn(async () => null),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: DOC, blobUrl: OLD_BLOB }) }) }) },
}));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: {
    findOne: (filter: { _id: Types.ObjectId }) => ({ select: () => ({ lean: async () => state.uploads.get(String(filter._id)) ?? null }) }),
  },
}));

async function get(v: string) {
  const { GET } = await import("@/app/api/docs/[docId]/pdf/route");
  const res = await GET(new Request(`http://localhost:3001/api/docs/${DOC}/pdf?v=${v}&ready=1`), { params: Promise.resolve({ docId: String(DOC) }) });
  return { status: res.status, location: res.headers.get("location"), cache: res.headers.get("cache-control") };
}

beforeEach(() => {
  state.uploads.clear();
  state.uploads.set(String(V2), { blobUrl: OLD_BLOB });
});

describe("GET /api/docs/:docId/pdf?v=<uploadId>", () => {
  test("an upload whose blob exists: its own bytes, cached for a year", async () => {
    state.uploads.set(String(V3), { blobUrl: NEW_BLOB });
    expect(await get(String(V3))).toEqual({ status: 302, location: NEW_BLOB, cache: "private, max-age=31536000, immutable" });
    expect(await get(String(V2))).toEqual({ status: 302, location: OLD_BLOB, cache: "private, max-age=31536000, immutable" });
  });

  test("an upload still processing: the current bytes, never cached under the new key", async () => {
    state.uploads.set(String(V3), {});
    expect(await get(String(V3))).toEqual({ status: 302, location: OLD_BLOB, cache: "private, no-store" });
  });

  test("v=0 before the page knows the version: current bytes, not cached", async () => {
    expect(await get("0")).toEqual({ status: 302, location: OLD_BLOB, cache: "private, no-store" });
  });
});
