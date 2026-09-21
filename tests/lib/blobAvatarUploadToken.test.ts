/**
 * `POST /api/blob/upload` mints the client token that writes straight to Vercel Blob, so whatever
 * that token permits is what the product permits — the browser's own checks never run for a caller
 * who skips the UI.
 *
 * It used to hand every prefix the same constraints: `maximumSizeInBytes:
 * CLIENT_UPLOAD_MAX_SIZE_BYTES`, 250MB, the *document* ceiling, to anyone holding any membership
 * row in the target workspace — `viewer` included, and an API key too. The avatar rules (≤2MB,
 * square, ≥120px) live in `WorkspaceManager.uploadAvatarFile`, i.e. in the browser. So a crafted
 * client could park 250MB of arbitrary image bytes per call under `org-avatars/<orgId>/`, as often
 * as it liked, and nothing ever collects blobs that no org row points at.
 *
 * Pinned here: the avatar prefix gets its own small ceiling, documents keep theirs, and the three
 * gates that were missing (owner/admin, no API keys, a rate limit) all refuse.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { ORG_ID, USER_ID, DOC_ID, UPLOAD_ID, connectMongo, membershipFindOne, uploadExists, rateLimit, actor } =
  vi.hoisted(() => {
    const ORG_ID = "64b0c0ffee0000000000e001";
    const USER_ID = "64b0c0ffee0000000000e002";
    const DOC_ID = "64b0c0ffee0000000000e003";
    const UPLOAD_ID = "64b0c0ffee0000000000e004";
    return {
      ORG_ID,
      USER_ID,
      DOC_ID,
      UPLOAD_ID,
      connectMongo: vi.fn(async () => undefined),
      membershipFindOne: vi.fn(),
      uploadExists: vi.fn(async () => ({ _id: UPLOAD_ID })),
      rateLimit: vi.fn(async () => ({ ok: true, remaining: 19, retryAfterSec: 0 })),
      actor: {
        current: {
          kind: "user",
          userId: USER_ID,
          orgId: ORG_ID,
          personalOrgId: ORG_ID,
        } as Record<string, unknown>,
      },
    };
  });

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { findOne: membershipFindOne, exists: vi.fn() } }));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: { exists: uploadExists } }));
vi.mock("@/lib/gating/actor", () => ({ resolveExistingActor: vi.fn(async () => actor.current) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  // `rateLimitedResponse` is real: the 429 body and `Retry-After` header are part of what we pin.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, rateLimit };
});

/**
 * Stand in for the Blob SDK: run the route's `onBeforeGenerateToken` for the pathname under test
 * and hand back what it returned, so the constraints the token would carry are observable.
 */
vi.mock("@vercel/blob/client", () => ({
  handleUpload: async (args: {
    body: { payload?: { pathname?: string; clientPayload?: string | null } };
    request: Request;
    onBeforeGenerateToken: (pathname: string, clientPayload: string | null) => Promise<unknown>;
  }) => {
    const pathname = args.body?.payload?.pathname ?? "";
    const clientPayload = args.body?.payload?.clientPayload ?? null;
    return await args.onBeforeGenerateToken(pathname, clientPayload);
  },
}));

const { POST } = await import("@/app/api/blob/upload/route");
const { CLIENT_UPLOAD_MAX_SIZE_BYTES } = await import("@/lib/blob/serverClientUploadRoute");

/**
 * The avatar ceiling, restated. The route keeps it private (route files here export handlers and
 * route config only), so it is pinned through the token the route mints rather than imported.
 */
const AVATAR_UPLOAD_MAX_SIZE_BYTES = 8 * 1024 * 1024;

/** A token request for `pathname`, shaped the way the Blob client sends it. */
function tokenRequest(pathname: string): Request {
  return new Request("https://example.test/api/blob/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "blob.generate-client-token", payload: { pathname, clientPayload: null } }),
  });
}

/** Make the membership lookup answer with `role` (or nothing, for a non-member). */
function memberWithRole(role: string | null) {
  membershipFindOne.mockReturnValue({
    select: () => ({ lean: async () => (role === null ? null : { role }) }),
  });
}

const AVATAR_PATH = `org-avatars/${ORG_ID}/1700000000000-icon.png`;
const DOC_PATH = `docs/${DOC_ID}/uploads/${UPLOAD_ID}/file.pdf`;

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { kind: "user", userId: USER_ID, orgId: ORG_ID, personalOrgId: ORG_ID };
  uploadExists.mockResolvedValue({ _id: UPLOAD_ID });
  rateLimit.mockResolvedValue({ ok: true, remaining: 19, retryAfterSec: 0 });
  memberWithRole("owner");
});

describe("POST /api/blob/upload — avatar tokens", () => {
  test("an avatar token is capped well below the document ceiling", async () => {
    const res = await POST(tokenRequest(AVATAR_PATH));
    const json = (await res.json()) as { maximumSizeInBytes?: number; allowedContentTypes?: string[] };

    expect(json.maximumSizeInBytes).toBe(AVATAR_UPLOAD_MAX_SIZE_BYTES);
    // The regression itself: this was 250MB for an icon.
    expect(json.maximumSizeInBytes).toBeLessThan(CLIENT_UPLOAD_MAX_SIZE_BYTES / 10);
    // And it still only accepts real images.
    expect(json.allowedContentTypes).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(json.allowedContentTypes).not.toContain("application/pdf");
  });

  test("document tokens keep the 250MB browser-direct ceiling", async () => {
    const res = await POST(tokenRequest(DOC_PATH));
    const json = (await res.json()) as { maximumSizeInBytes?: number; allowedContentTypes?: string[] };

    expect(json.maximumSizeInBytes).toBe(CLIENT_UPLOAD_MAX_SIZE_BYTES);
    expect(json.allowedContentTypes).toEqual(["application/pdf"]);
  });

  test("an admin may mint one", async () => {
    memberWithRole("admin");
    const res = await POST(tokenRequest(AVATAR_PATH));
    expect(res.status).toBe(200);
  });

  test("a member cannot — the route that stores the URL is owner/admin too", async () => {
    memberWithRole("member");
    const res = await POST(tokenRequest(AVATAR_PATH));
    expect(res.status).toBe(403);
  });

  test("a viewer cannot", async () => {
    memberWithRole("viewer");
    const res = await POST(tokenRequest(AVATAR_PATH));
    expect(res.status).toBe(403);
  });

  test("a non-member cannot", async () => {
    memberWithRole(null);
    const res = await POST(tokenRequest(AVATAR_PATH));
    expect(res.status).toBe(403);
  });

  test("an API key cannot rebrand a workspace, however well-scoped", async () => {
    actor.current = { ...actor.current, viaApiKey: { keyId: "k1", scopes: ["write"] } };
    const res = await POST(tokenRequest(AVATAR_PATH));
    const json = (await res.json()) as { error?: string };

    expect(res.status).toBe(403);
    expect(json.error).toBe("api_key_forbidden");
    // Refused before the membership lookup: a key is never the right actor here, whatever its role.
    expect(membershipFindOne).not.toHaveBeenCalled();
  });

  test("minting is rate-limited per member and workspace", async () => {
    rateLimit.mockResolvedValue({ ok: false, remaining: 0, retryAfterSec: 120 });
    const res = await POST(tokenRequest(AVATAR_PATH));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: `blobavatar:${USER_ID}:${ORG_ID}` }),
    );
  });

  test("an anonymous caller gets 401, not a token", async () => {
    actor.current = null as unknown as Record<string, unknown>;
    const res = await POST(tokenRequest(AVATAR_PATH));
    expect(res.status).toBe(401);
  });
});
