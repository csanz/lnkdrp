/**
 * Client component for the owner project links page.
 * Route: `/project/:projectId/links`
 *
 * The project page's side panel only summarises the links; this page is where they are managed.
 * Deliberately the same shell as `/doc/:docId/links` — the same `SubPageHeader` band, the same
 * breadcrumb shape, the same Links/Metrics actions and New link button, the same intro, and the
 * same `LinksManager` table underneath. The two shells are separate files rather than one parameterised component because
 * they differ only in the title fetch and three nouns, and a shared shell would have to carry a
 * scope object through JSX that is already only a hundred lines long; the table, which is where
 * the behaviour lives, is genuinely shared.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { ChartBarIcon, LinkIcon, PlusIcon } from "@heroicons/react/24/outline";

import LinksManager, { type LinksManagerHandle } from "@/components/links/LinksManager";
import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader, { SubPageAction } from "@/components/SubPageHeader";
import { usePlan } from "@/lib/client/usePlan";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/**
 * Render the ProjectLinksPageClient UI (uses effects, local state).
 */
export default function LinksPageClient({ projectId }: { projectId: string }) {
  const [projectName, setProjectName] = useState<string>("");
  const managerRef = useRef<LinksManagerHandle | null>(null);
  const { plan } = usePlan();
  /**
   * Writes on project links take `admin` (the project routes' gate), one rank above the `member`
   * who may edit a document link — so `plan.canManageLinks` is the wrong test here and would show
   * a member controls the server refuses. Fails closed while the snapshot loads.
   */
  const canManage = plan ? plan.role === "owner" || plan.role === "admin" : false;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // `/api/projects/:id` has no GET (only PATCH/DELETE); the project row rides along with its
        // document list, and `limit=1` keeps that read to one document for a header title.
        const res = await fetchWithTempUser(`/api/projects/${encodeURIComponent(projectId)}/docs?limit=1`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as { project?: { name?: unknown } } | null;
        const t = typeof json?.project?.name === "string" ? json.project.name.trim() : "";
        if (!cancelled && t) setProjectName(t);
      } catch {
        // the header falls back to "Project"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="flex h-full flex-col">
      {/* The project's own header band, unchanged in height, gutter and title line — you are still
          inside the project, so the page should not look like somewhere else. The breadcrumb takes
          the description's place and the first crumb is the way back. */}
      <SubPageHeader
        kind="project"
        title={projectName || "Project"}
        titleHref={`/project/${encodeURIComponent(projectId)}`}
        crumbs={[{ label: "Project", href: `/project/${encodeURIComponent(projectId)}` }, { label: "Links" }]}
        actions={
          <div className="flex items-center gap-2">
            <SubPageAction href={`/project/${encodeURIComponent(projectId)}/links`} label="Links" active>
              <LinkIcon className="h-4 w-4" aria-hidden="true" />
            </SubPageAction>
            {/* Every row's own "Analytics" button scopes to that one link; this is the way out of
                the table to the metrics page that sums across all of them. */}
            <SubPageAction href={`/project/${encodeURIComponent(projectId)}/metrics`} label="Metrics">
              <ChartBarIcon className="h-4 w-4" aria-hidden="true" />
            </SubPageAction>
            {canManage ? (
              <button
                type="button"
                onClick={() => managerRef.current?.openCreate()}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 text-[13px] font-semibold text-[var(--primary-fg)] shadow-sm transition-colors hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)]"
              >
                <PlusIcon className="h-4 w-4" aria-hidden="true" />
                New link
              </button>
            ) : null}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`w-full py-6 ${APP_PAGE_GUTTER}`}>
          <div className="mb-5">
            <div className="flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
              <LinkIcon className="h-[18px] w-[18px] text-[var(--muted-2)]" aria-hidden="true" />
              <span>Links</span>
            </div>
            <div className="mt-1 text-sm text-[var(--muted)]">
              One link per audience, each with its own settings and its own stats. Labels are private
              to you — recipients never see them.
            </div>
          </div>

          <LinksManager ref={managerRef} scope={{ kind: "project", id: projectId }} variant="page" canManage={canManage} />

          {/* Contents follow the project (PRD decision 4): say so, so nobody assumes a link can
              carry a subset of the documents. The document table needs no such line — a document
              link carries one document by definition. */}
          <div className="mt-3 text-[12px] leading-5 text-[var(--muted-2)]">
            Every link shows this project&apos;s current documents. Choosing a different set per link
            is not possible yet.
          </div>
        </div>
      </div>
    </div>
  );
}
