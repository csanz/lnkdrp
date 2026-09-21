/**
 * Two public surfaces that answered a question nobody was allowed to ask them.
 *
 * - `/p/:shareId/:docId` resolved the link **and** the document in one call, so a
 *   password-protected data room answered a candidate document id with a 200 password gate when
 *   the id was inside it and a 404 when it was not. Walking a list of ids against a locked room
 *   therefore returned its exact contents — the inventory the gate exists to withhold, which is
 *   why it renders `title={null} previewUrl={null}`. The fix is pure ordering: the gate goes up
 *   before the room is asked anything about the document, so `findProjectDocument` must not have
 *   been called at all on the locked path.
 *
 * - `/s/:shareId/og.png` dereferenced the document's stored `previewImageUrl` as-is. That field is
 *   owner-controlled text (`PATCH /api/docs/:docId` stores the string unvalidated) and the route is
 *   unauthenticated, so `http://169.254.169.254/…` became a server-side request to the instance
 *   metadata service and `../../../../etc/passwd` became `readFileSync(join(process.cwd(), …))`.
 *   The fix is an allowlist of the blob CDN previews actually live on, with everything else falling
 *   through to the text card the route already renders — so the failure mode is a missing preview,
 *   not a broken page.
 *
 * Both are pinned on the side effect, not the response body: "did it go and fetch/read the thing"
 * and "was the room asked" are the whole protection here.
 */
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const SHARE_ID = "pl_locked01";
/** A document that really is in the locked room. */
const MEMBER_DOC = new Types.ObjectId().toString();
/** A plausible id that is not — what an attacker walking the id space is holding. */
const OUTSIDER_DOC = new Types.ObjectId().toString();
const UNLOCK_COOKIE = "the-unlock-cookie";

// --- shared module mocks -----------------------------------------------------------------------

class NotFoundError extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

// --- /p/:shareId/:docId ------------------------------------------------------------------------

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: (...a: any[]) => (resolveProjectLink as any)(...a),
}));

const findProjectDocument = vi.fn();
const resolveProjectDocument = vi.fn();
vi.mock("@/lib/share/projectPublic", () => ({
  findProjectDocument: (...a: any[]) => (findProjectDocument as any)(...a),
  resolveProjectDocument: (...a: any[]) => (resolveProjectDocument as any)(...a),
  // The real predicate: it is pure, and it is the thing that decides "locked".
  projectLinkPasswordEnabled: (link: any) => Boolean(link?.passwordHash) && Boolean(link?.passwordSalt),
}));

const cookieGet = vi.fn((_name: string) => undefined as { value: string } | undefined);
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => cookieGet(n) }) }));

vi.mock("@/lib/sharePassword", () => ({
  shareAuthCookieName: (id: string) => `share_auth_${id}`,
  shareAuthCookieValue: () => UNLOCK_COOKIE,
}));
vi.mock("@/lib/share/shareBrand", () => ({ workspaceBrandForOrg: async () => null }));
vi.mock("@/lib/share/shareMetadata", () => ({ buildShareMetadata: async () => ({}) }));

// Rendered output is identified by component identity, so each stand-in keeps its real name.
vi.mock("@/components/PasswordGate", () => ({
  default: function PasswordGate() {
    return null;
  },
}));
vi.mock("@/components/BrandHeader", () => ({
  default: function BrandHeader() {
    return null;
  },
}));
vi.mock("@/app/s/[shareId]/ShareViewerClient", () => ({
  default: function ShareViewerClient() {
    return null;
  },
}));
vi.mock("@/app/p/[shareId]/RefusalNotice", () => ({
  default: function RefusalNotice() {
    return null;
  },
}));

// --- /s/:shareId/og.png ------------------------------------------------------------------------

const resolveShareLink = vi.fn();
vi.mock("@/lib/share/links", () => ({ resolveShareLink: (...a: any[]) => (resolveShareLink as any)(...a) }));

const imageResponseFromBytes = vi.fn((params: { cacheControl?: string }) => ({
  kind: "bytes" as const,
  cacheControl: params.cacheControl ?? null,
}));
vi.mock("@/lib/og/imageResponse", () => ({
  DEFAULT_OG_SIZE: { width: 1200, height: 630 },
  imageResponseFromBytes: (...a: any[]) => (imageResponseFromBytes as any)(...a),
  mimeFromPath: () => "image/png",
  sniffImageDims: () => ({ width: 1200, height: 630 }),
}));

/** The fallback text card is a real `ImageResponse`; we only need to recognise it. */
vi.mock("next/og", () => ({
  ImageResponse: class {
    headers = new Headers();
    constructor(
      public element: unknown,
      public opts: unknown,
    ) {}
  },
}));

/**
 * The filesystem branch is gone, so nothing should reach `readFileSync` any more. Kept mocked (and
 * asserted on) because "it is not called" is exactly the regression: the old route called it with
 * `join(process.cwd(), previewImageUrl)`.
 */
const readFileSync = vi.fn(() => Buffer.from("root:x:0:0:root:/root:/bin/bash"));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileSync: (...a: any[]) => (readFileSync as any)(...a),
}));

import ProjectLinkDocumentPage from "@/app/p/[shareId]/[docId]/page";
import { GET as ogRoute } from "@/app/s/[shareId]/og.png/route";

/** The name of the component a server page returned, so a gate and a viewer are told apart. */
/**
 * Props of the first descendant rendered by a component of this name.
 *
 * These page tests assert on the element tree the server component returns; nothing renders it, so
 * a component's own body never runs and props have to be read off the element.
 */
function propsOf(node: unknown, name: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === "function" && (el.type as { name?: string }).name === name) {
    return el.props ?? {};
  }
  const children = (el.props as { children?: unknown } | undefined)?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = propsOf(child, name);
    if (hit) return hit;
  }
  return null;
}

function componentName(node: unknown): string {
  const type = (node as { type?: unknown } | null)?.type;
  if (typeof type === "function") return (type as { name?: string }).name ?? "";
  return String(type);
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
});

describe("a document opened out of a room says which room", () => {
  const openLink = { orgId: "6500000000000000000000aa" };
  const project = { _id: "6500000000000000000000bb", isRequest: false, name: "Series B data room" };

  beforeEach(() => {
    resolveProjectLink.mockResolvedValue({ link: openLink, project, refusal: null });
    findProjectDocument.mockResolvedValue({ _id: MEMBER_DOC, title: "Term sheet", blobUrl: "https://blob/x.pdf" });
  });

  const render = () =>
    ProjectLinkDocumentPage({ params: Promise.resolve({ shareId: SHARE_ID, docId: MEMBER_DOC }) } as never);

  test("the viewer is handed the way back, and the room's name to put on it", async () => {
    /**
     * `PdfJsViewer` has taken `backHref`/`backLabel` since it was written, with a comment saying
     * exactly what they are for — "a recipient who clicks a document out of a data room is one
     * browser-back from the list, and browser-back is exactly what people do not reach for inside a
     * viewer that has taken over the window". Nothing passed them. A control that is built and
     * never called is the same as one that does not exist, so this pins the wiring rather than the
     * rendering.
     */
    const props = propsOf(await render(), "ShareViewerClient");

    expect(props).not.toBeNull();
    expect(props!.backHref).toBe(`/p/${SHARE_ID}`);
    expect(props!.backLabel).toBe("Series B data room");
  });

  test("a room with no name gets the arrow, not the word \"undefined\"", async () => {
    resolveProjectLink.mockResolvedValue({ link: openLink, project: { ...project, name: "" }, refusal: null });

    const props = propsOf(await render(), "ShareViewerClient");

    expect(props!.backHref).toBe(`/p/${SHARE_ID}`);
    // `PdfJsViewer` falls back to "Back" on null; it must not be handed an empty string to render.
    expect(props!.backLabel).toBeNull();
  });
});

describe("a locked data room does not confirm which documents are inside it", () => {
  const lockedLink = { orgId: "6500000000000000000000aa", passwordHash: "hash", passwordSalt: "salt" };
  const project = { _id: "6500000000000000000000bb", isRequest: false };

  beforeEach(() => {
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: null });
    // The room does hold MEMBER_DOC — the old code's 200/404 split came from exactly this.
    findProjectDocument.mockImplementation(async (_project: unknown, docId: string) =>
      String(docId) === MEMBER_DOC ? { _id: MEMBER_DOC, title: "Term sheet", blobUrl: "https://blob/x.pdf" } : null,
    );
  });

  const render = (docId: string) =>
    ProjectLinkDocumentPage({ params: Promise.resolve({ shareId: SHARE_ID, docId }) } as never);

  test("a document that is in the room gets the password gate", async () => {
    expect(componentName(await render(MEMBER_DOC))).toBe("PasswordGate");
  });

  test("a document that is not in the room gets the same answer, not a 404", async () => {
    expect(componentName(await render(OUTSIDER_DOC))).toBe("PasswordGate");
  });

  test("the room is never asked whether it holds the document before the password", async () => {
    await render(OUTSIDER_DOC);
    await render(MEMBER_DOC);
    // This is the fix: membership is not consulted at all while the gate is up, so there is no
    // answer for it to differ on — not even a timing one.
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("a malformed id is indistinguishable from a real one too", async () => {
    expect(componentName(await render("not-an-object-id"))).toBe("PasswordGate");
  });

  test("behind the correct cookie the room answers normally again", async () => {
    cookieGet.mockReturnValue({ value: UNLOCK_COOKIE });

    // A member document renders the viewer...
    expect(componentName(await render(MEMBER_DOC))).toBe("main");
    // ...and only now does a non-member id become a 404, which is correct: the caller has the
    // password, so "that document is not in this room" is no longer a secret.
    await expect(render(OUTSIDER_DOC)).rejects.toBeInstanceOf(NotFoundError);
    expect(findProjectDocument).toHaveBeenCalledTimes(2);
  });

  test("an unlocked room still 404s a non-member id", async () => {
    resolveProjectLink.mockResolvedValue({ link: { orgId: lockedLink.orgId }, project, refusal: null });
    await expect(render(OUTSIDER_DOC)).rejects.toBeInstanceOf(NotFoundError);
    expect(componentName(await render(MEMBER_DOC))).toBe("main");
  });

  test("a link-level refusal still says so instead of asking for a password", async () => {
    // Expiry is a property of the link the recipient already holds, not of its contents, so it
    // stays ahead of the gate: "ask them for a fresh link" beats a password that will not help.
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: "expired" });
    expect(componentName(await render(MEMBER_DOC))).toBe("RefusalNotice");
    // And the same for an id the room does not hold. A refused link used to 404 on a non-member id
    // and show the notice on a member one — the same oracle, one refusal further along.
    expect(componentName(await render(OUTSIDER_DOC))).toBe("RefusalNotice");
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("a request repo is still a 404 by deep link, gate or no gate", async () => {
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project: { ...project, isRequest: true }, refusal: null });
    await expect(render(MEMBER_DOC)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("/s/:shareId/og.png only dereferences the blob store", () => {
  const params = Promise.resolve({ shareId: "sh_abc123" });
  // The parameters are declared so `fetchMock.mock.calls[0][0]` types as the URL that was asked for
  // — asserting on it is the point of the last tests here.
  const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
    headers: { get: () => "image/png" },
  }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Point the (unauthenticated) route at a stored preview value and run it. */
  const renderCard = (previewImageUrl: string) => {
    resolveShareLink.mockResolvedValue({
      refusal: null,
      link: {},
      doc: { title: "Series B deck", previewImageUrl },
    });
    return ogRoute({} as never, { params }) as unknown as Promise<{ headers: Headers }>;
  };

  test("a link-local metadata address is not requested", async () => {
    const res = await renderCard("http://169.254.169.254/latest/meta-data/iam/security-credentials/");

    expect(fetchMock).not.toHaveBeenCalled();
    // It degrades rather than refusing: the document still unfurls, with its title.
    expect(imageResponseFromBytes).not.toHaveBeenCalled();
    // This used to assert `private`. That header was an over-correction: the image is keyed on the
    // link and identical for everyone who may see it, so refusing every shared cache made each
    // unfurl a cold origin render — and a link pasted once into a large channel is fetched by many
    // bots at once. It is a short `s-maxage` now, which keeps the revocation window to a minute
    // while letting the edge absorb the burst. See the route for the full trade.
    const cacheControl = res.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toContain("s-maxage");
    expect(cacheControl).not.toContain("stale-while-revalidate");
  });

  test("an arbitrary external host is not requested either", async () => {
    await renderCard("https://attacker.example/collect.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a relative path is not read off the server's disk", async () => {
    await renderCard("../../../../etc/passwd");

    expect(readFileSync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an absolute path is not read off the server's disk either", async () => {
    await renderCard("/dev/zero");

    expect(readFileSync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("plaintext http to the blob host is refused as well", async () => {
    await renderCard("http://blob.vercel-storage.com/docs/abc/preview.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the real preview still renders — the allowlist is not a wall", async () => {
    const blobPreview = "https://blob.vercel-storage.com/docs/650000000000000000000001/uploads/650000000000000000000002/preview.png";
    await renderCard(blobPreview);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(blobPreview);
    expect(imageResponseFromBytes).toHaveBeenCalledTimes(1);
  });

  test("a store subdomain of the blob CDN renders too", async () => {
    await renderCard("https://abc123.public.blob.vercel-storage.com/docs/x/preview.png");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a host that merely ends with the CDN name is not the CDN", async () => {
    // `evilblob.vercel-storage.com.attacker.example` and `notblob.vercel-storage.com` are the two
    // shapes a suffix check gets wrong; the separator dot is what makes it a subdomain.
    await renderCard("https://blob.vercel-storage.com.attacker.example/x.png");
    await renderCard("https://notblob.vercel-storage.com/x.png");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
