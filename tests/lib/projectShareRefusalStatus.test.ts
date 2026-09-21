/**
 * Every `/p/**` refusal used to answer `200 OK`.
 *
 * `loading.tsx` exists in both `/p/:shareId` and `/p/:shareId/:docId`, so each page renders inside a
 * Suspense boundary: Next commits the status before the page body runs, and the page's own
 * `notFound()` then renders the right screen under the wrong status line. An unknown slug, a
 * document slug pasted into `/p/`, a deleted project, a request repo and a disabled/expired/archived
 * link all came back as live pages to the two readers that only look at the status: crawlers and
 * monitors. `/s/:shareId` solved this with a segment layout (it renders above the boundary and is
 * awaited before anything is sent); this pins the `/p` counterpart.
 *
 * The layout is the *status*, not the authorization — the pages keep their own checks — so what is
 * pinned here is only that each non-servable state reaches `notFound()`, and that a servable one
 * passes `children` through untouched.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const SHARE_ID = "pl_room01";

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: (...a: any[]) => (resolveProjectLink as any)(...a),
}));

class NotFoundError extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

import ProjectShareLayout from "@/app/p/[shareId]/layout";

/** A string is a perfectly good `ReactNode`, and identity is all these assertions need. */
const CHILDREN = "the room";

const link = { _id: "link", orgId: "org", enabled: true, passwordHash: null, passwordSalt: null };
const project = { _id: "project", name: "Data room", orgId: "org", isRequest: false };

async function render(shareId = SHARE_ID) {
  return ProjectShareLayout({ children: CHILDREN, params: Promise.resolve({ shareId }) });
}

beforeEach(() => {
  resolveProjectLink.mockReset();
});

describe("/p/:shareId refuses with a 404 status, not a 200 page", () => {
  test("an unknown slug (or a document link's slug) 404s", async () => {
    resolveProjectLink.mockResolvedValue(null);
    await expect(render()).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an empty slug 404s without touching the resolver", async () => {
    await expect(render("")).rejects.toBeInstanceOf(NotFoundError);
    expect(resolveProjectLink).not.toHaveBeenCalled();
  });

  test.each(["disabled", "expired", "archived", "project_gone"] as const)("a %s link 404s", async (refusal) => {
    resolveProjectLink.mockResolvedValue({ link, project, refusal });
    await expect(render()).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a request repo 404s — its submissions are somebody else's documents", async () => {
    resolveProjectLink.mockResolvedValue({ link, project: { ...project, isRequest: true }, refusal: null });
    await expect(render()).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a servable link renders the segment", async () => {
    resolveProjectLink.mockResolvedValue({ link, project, refusal: null });
    await expect(render()).resolves.toBe(CHILDREN);
  });

  test("`isRequest` is asked for explicitly — an unselected field would read as undefined", async () => {
    resolveProjectLink.mockResolvedValue({ link, project, refusal: null });
    await render();
    expect(resolveProjectLink).toHaveBeenCalledWith(SHARE_ID, { select: { isRequest: 1 } });
  });
});
