/**
 * A document that is not in the room answered `200 OK` from `/p/:shareId/:docId`.
 *
 * `src/app/p/[shareId]/layout.tsx` killed the soft-404 for the slug; this is the same bug one level
 * deeper, and it survived that fix because a layout at `[shareId]` cannot see a `docId`. The page's
 * membership `notFound()` throws inside the Suspense boundary `loading.tsx` creates, so the status
 * was already committed: `/p/<a live room>/000000000000000000000001` came back `200`, and so did
 * every real document of the workspace that is not in *that* project: a live page to the two
 * readers that only look at the status line, crawlers and monitors.
 *
 * `src/app/p/[shareId]/[docId]/layout.tsx` is the half of the fix that lives in this segment: a
 * layout is awaited above its own boundary, so its `notFound()` reaches the response. The other
 * half is not this segment's to make and is named in that file's docblock, so these assertions are
 * deliberately about the layout's decisions rather than about an HTTP status: that each non-member
 * id reaches `notFound()`, that a member passes through untouched, and, above all, the ordering.
 * On a locked room the layout must not ask the room anything, or the 404/200 split it introduces
 * becomes exactly the membership oracle the gate is written to withhold.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const SHARE_ID = "pl_room01";
const MEMBER_DOC = "6ab20688d7e47b3f56a11aa1";
/** A plausible id that is not in the room: what someone walking the id space is holding. */
const OUTSIDER_DOC = "000000000000000000000001";
const UNLOCK_COOKIE = "the-unlock-cookie";

class NotFoundError extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: (...a: any[]) => (resolveProjectLink as any)(...a),
  // The page-render wrapper (React.cache over resolveProjectLink) resolves through the same mock.
  resolveProjectLinkForPage: (shareId: string) => (resolveProjectLink as any)(shareId, { select: { description: 1, isRequest: 1 } }),
}));

const findProjectDocument = vi.fn();
vi.mock("@/lib/share/projectPublic", () => ({
  findProjectDocument: (...a: any[]) => (findProjectDocument as any)(...a),
  // The real predicate: it is pure, and it is the thing that decides "locked".
  projectLinkPasswordEnabled: (link: any) => Boolean(link?.passwordHash) && Boolean(link?.passwordSalt),
}));

const cookieGet = vi.fn((_name: string) => undefined as { value: string } | undefined);
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => cookieGet(n) }) }));

vi.mock("@/lib/sharePassword", () => ({
  shareAuthCookieName: (id: string) => `share_auth_${id}`,
  shareAuthCookieValue: () => UNLOCK_COOKIE,
}));

import ProjectShareDocumentLayout from "@/app/p/[shareId]/[docId]/layout";

/** A string is a perfectly good `ReactNode`, and identity is all these assertions need. */
const CHILDREN = "the document";

const link = { _id: "link", orgId: "org", enabled: true, passwordHash: null, passwordSalt: null };
const lockedLink = { ...link, passwordHash: "hash", passwordSalt: "salt" };
const project = { _id: "project", name: "Data room", orgId: "org", isRequest: false };

async function render(docId = MEMBER_DOC, shareId = SHARE_ID) {
  return ProjectShareDocumentLayout({ children: CHILDREN, params: Promise.resolve({ shareId, docId }) });
}

beforeEach(() => {
  resolveProjectLink.mockReset();
  findProjectDocument.mockReset();
  cookieGet.mockReset();
  cookieGet.mockReturnValue(undefined);
  resolveProjectLink.mockResolvedValue({ link, project, refusal: null });
  findProjectDocument.mockImplementation(async (_project: any, docId: string) =>
    docId === MEMBER_DOC ? { _id: MEMBER_DOC, title: "Series A Deck" } : null,
  );
});

describe("/p/:shareId/:docId refuses a non-member document with a 404 status, not a 200 page", () => {
  test("a document that is not in the room 404s", async () => {
    await expect(render(OUTSIDER_DOC)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a document that is in the room renders the segment", async () => {
    await expect(render(MEMBER_DOC)).resolves.toBe(CHILDREN);
  });

  test("an empty docId 404s without touching the resolver", async () => {
    await expect(render("")).rejects.toBeInstanceOf(NotFoundError);
    expect(resolveProjectLink).not.toHaveBeenCalled();
  });

  test("membership is asked of the project the slug resolved to, not of anything in the URL", async () => {
    await render(MEMBER_DOC);
    expect(findProjectDocument).toHaveBeenCalledWith(project, MEMBER_DOC);
  });

  test("`isRequest` is asked for explicitly, since an unselected field would read as undefined", async () => {
    await render(MEMBER_DOC);
    // The page goes through `resolveProjectLinkForPage`, whose select is the union every segment of
    // the page needs; `isRequest` must be in it, whatever else is.
    expect(resolveProjectLink).toHaveBeenCalledWith(SHARE_ID, expect.objectContaining({ select: expect.objectContaining({ isRequest: 1 }) }));
  });
});

describe("the gate stays ahead of membership, so a locked room answers every id the same way", () => {
  beforeEach(() => {
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: null });
  });

  test("with no cookie the room is not asked at all, for a member or an outsider", async () => {
    await expect(render(MEMBER_DOC)).resolves.toBe(CHILDREN);
    await expect(render(OUTSIDER_DOC)).resolves.toBe(CHILDREN);
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("a wrong cookie is no cookie", async () => {
    cookieGet.mockReturnValue({ value: "not-the-unlock-cookie" });
    await expect(render(OUTSIDER_DOC)).resolves.toBe(CHILDREN);
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("behind the gate the answers split again, which is correct: the caller has the password", async () => {
    cookieGet.mockReturnValue({ value: UNLOCK_COOKIE });
    await expect(render(MEMBER_DOC)).resolves.toBe(CHILDREN);
    await expect(render(OUTSIDER_DOC)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("link-level states belong to the layout above, and are left to it", () => {
  test.each(["disabled", "expired", "archived", "project_gone"] as const)("a %s link passes through untouched", async (refusal) => {
    resolveProjectLink.mockResolvedValue({ link, project, refusal });
    await expect(render(OUTSIDER_DOC)).resolves.toBe(CHILDREN);
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("an unknown slug passes through untouched", async () => {
    resolveProjectLink.mockResolvedValue(null);
    await expect(render(OUTSIDER_DOC)).resolves.toBe(CHILDREN);
    expect(findProjectDocument).not.toHaveBeenCalled();
  });

  test("a request repo passes through untouched", async () => {
    resolveProjectLink.mockResolvedValue({ link, project: { ...project, isRequest: true }, refusal: null });
    await expect(render(OUTSIDER_DOC)).resolves.toBe(CHILDREN);
    expect(findProjectDocument).not.toHaveBeenCalled();
  });
});
