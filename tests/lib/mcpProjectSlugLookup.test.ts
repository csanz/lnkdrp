/**
 * `loadProject` (mcp/src/tools/projects.ts) resolves a `projectSlug` with one call to
 * `GET /api/projects/:slug` and not, as it used to, with a name search followed by a scan of up to
 * fifty list pages. The scan is kept for one case the route names, `reason:
 * "slug_backfill_pending"`, because listing is what gives a pre-slug legacy project its slug.
 *
 * Every tool that names a project (projects, project links, share_pdf's `projectSlug`) goes
 * through `loadProject`, so this is the one place the resolution is pinned.
 */
import { describe, expect, test, vi } from "vitest";

import type { ApiClient, ApiProject, ApiProjectDocsPage } from "../../mcp/src/api";
import { ToolError } from "../../mcp/src/errors";
import { loadProject } from "../../mcp/src/tools/projects";

const PROJECT_ID = "64b0c0ffee0000000000e001";

function project(overrides: Partial<ApiProject> = {}): ApiProject {
  return {
    id: PROJECT_ID,
    shareId: "LfX8olGVThDy",
    name: "Series A data room",
    slug: "series-a-data-room",
    description: "",
    docCount: 1,
    autoAddFiles: false,
    shareEnabled: true,
    isRequest: false,
    createdDate: null,
    updatedDate: null,
    ...overrides,
  };
}

function docsPage(p: ApiProject): ApiProjectDocsPage {
  return { project: p, total: 0, page: 1, limit: 1, docs: [] };
}

/** A missing-project error the way `mapApiError` builds one for `/api/projects/...` 404s. */
function notFound(reason?: string) {
  return new ToolError("not_found", "No such project in this workspace.", {
    status: 404,
    ...(reason ? { details: { reason } } : {}),
  });
}

type Impl = {
  getProjectBySlug?: (slug: string) => Promise<ApiProject>;
  listProjects?: (input: { page?: number; limit: number }) => Promise<{ total: number; page: number; limit: number; projects: ApiProject[] }>;
  getProjectDocs?: (id: string, input: { limit: number }) => Promise<ApiProjectDocsPage>;
};

function fakeApi(impl: Impl) {
  const getProjectBySlug = vi.fn(
    impl.getProjectBySlug ??
      (async () => {
        throw notFound();
      }),
  );
  const listProjects = vi.fn(impl.listProjects ?? (async () => ({ total: 0, page: 1, limit: 50, projects: [] })));
  const getProjectDocs = vi.fn(impl.getProjectDocs ?? (async () => docsPage(project())));
  return {
    api: { getProjectBySlug, listProjects, getProjectDocs } as unknown as ApiClient,
    getProjectBySlug,
    listProjects,
    getProjectDocs,
  };
}

describe("loadProject by slug", () => {
  test("one by-slug call, then the workspace-scoped docs read; the list is never touched", async () => {
    const { api, getProjectBySlug, listProjects, getProjectDocs } = fakeApi({ getProjectBySlug: async () => project() });
    const res = await loadProject(api, { projectSlug: "Series-A-Data-Room" });
    expect(res.project.id).toBe(PROJECT_ID);
    expect(getProjectBySlug).toHaveBeenCalledTimes(1);
    // Folded to the stored (lower-case) form before it goes over the wire.
    expect(getProjectBySlug).toHaveBeenCalledWith("series-a-data-room");
    expect(listProjects).not.toHaveBeenCalled();
    expect(getProjectDocs).toHaveBeenCalledWith(PROJECT_ID, { limit: 1 });
  });

  test("a plain 404 fails at once as not_found, without scanning the list", async () => {
    const { api, listProjects } = fakeApi({});
    await expect(loadProject(api, { projectSlug: "no-such-room" })).rejects.toMatchObject({ code: "not_found" });
    expect(listProjects).not.toHaveBeenCalled();
  });

  test("the list scan runs only for the legacy reason the route names, and finds the row the listing backfilled", async () => {
    const legacy = project({ id: "64b0c0ffee0000000000e002", slug: "old-room" });
    const { api, listProjects, getProjectDocs } = fakeApi({
      getProjectBySlug: async () => {
        throw notFound("slug_backfill_pending");
      },
      // The first page carries the just-backfilled slug; the scan stops at the page count.
      listProjects: async () => ({ total: 1, page: 1, limit: 50, projects: [legacy] }),
      getProjectDocs: async () => docsPage(legacy),
    });
    const res = await loadProject(api, { projectSlug: "old-room" });
    expect(res.project.id).toBe(legacy.id);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith({ page: 1, limit: 50 });
    expect(getProjectDocs).toHaveBeenCalledWith(legacy.id, { limit: 1 });
  });

  test("a scan that finds nothing is still not_found", async () => {
    const { api, listProjects } = fakeApi({
      getProjectBySlug: async () => {
        throw notFound("slug_backfill_pending");
      },
    });
    await expect(loadProject(api, { projectSlug: "gone" })).rejects.toMatchObject({ code: "not_found" });
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  test("other failures from the by-slug call are passed through untouched", async () => {
    const { api, listProjects } = fakeApi({
      getProjectBySlug: async () => {
        throw new ToolError("unauthorized", "The API key was not accepted by lnkdrp.", { status: 401 });
      },
    });
    await expect(loadProject(api, { projectSlug: "series-a-data-room" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(listProjects).not.toHaveBeenCalled();
  });

  test("a request repo resolved by slug is refused as not_found, like by id", async () => {
    const inbox = project({ isRequest: true, slug: "inbox" });
    const { api } = fakeApi({ getProjectBySlug: async () => inbox, getProjectDocs: async () => docsPage(inbox) });
    await expect(loadProject(api, { projectSlug: "inbox" })).rejects.toMatchObject({ code: "not_found" });
  });
});
