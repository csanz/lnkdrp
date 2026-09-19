/**
 * Client component for the owner project links page.
 * Route: `/project/:projectId/links`
 *
 * The project page's side panel only summarises the links; this page is where they are managed.
 * Deliberately the same shell as `/doc/:docId/links` — the same `SubPageHeader` band, the same
 * breadcrumb shape, the same Links/Metrics actions and New link button, the same intro, and the
 * same `LinksManager` table underneath. The two shells are separate files rather than one
 * parameterised component because they differ only in three nouns and who may write, and a shared
 * shell would have to carry a scope object through JSX that is already only a hundred lines long;
 * the table, which is where the behaviour lives, is genuinely shared.
 */
"use client";

import { useRef } from "react";
import { LinkIcon, PlusIcon } from "@heroicons/react/24/outline";

import LinksManager, { type LinksManagerHandle } from "@/components/links/LinksManager";
import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader from "@/components/SubPageHeader";
import EntityCrumbLabel from "@/components/HeaderIdentity";
import ProjectIdentityRow from "@/components/project/ProjectIdentityRow";
import ProjectHeaderActions from "@/components/project/ProjectHeaderActions";
import { usePlan } from "@/lib/client/usePlan";

/** Render the project's Links page: the project's own header band over the links table. */
export default function LinksPageClient({ projectId }: { projectId: string }) {
  const managerRef = useRef<LinksManagerHandle | null>(null);
  const { plan } = usePlan();
  /**
   * Writes on project links take `admin` (the project routes' gate), one rank above the `member`
   * who may edit a document link — so `plan.canManageLinks` is the wrong test here and would show
   * a member controls the server refuses. Fails closed while the snapshot loads.
   */
  const canManage = plan ? plan.role === "owner" || plan.role === "admin" : false;

  return (
    <div className="flex h-full flex-col">
      {/* The project's own header band, unchanged in height, gutter and title line — you are still
          inside the project, so the page should not look like somewhere else. The breadcrumb takes
          the description's place and the first crumb is the way back. */}
      <SubPageHeader
        kind="project"
        hideTile
        // The row finds the project's name itself now, so this page no longer keeps a copy of the
        // same fetch just to hand it down.
        title={<ProjectIdentityRow projectId={projectId} canManageTags={canManage} />}
        crumbs={[
          {
            label: <EntityCrumbLabel kind="project" id={projectId} noun="Project" />,
            href: `/project/${encodeURIComponent(projectId)}`,
          },
          { label: "Links" },
        ]}
        actions={
          // The project header's own cluster, unchanged. "New link" is not in it on purpose: a
          // button only this page has would push the two icons out of the place they occupy on the
          // other two pages, which is the whole point. It lives above the table instead.
          <ProjectHeaderActions projectSlug={projectId} current="links" />
        }
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`w-full py-6 ${APP_PAGE_GUTTER}`}>
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
                <LinkIcon className="h-[18px] w-[18px] text-[var(--muted-2)]" aria-hidden="true" />
                <span>Links</span>
              </div>
              <div className="mt-1 text-sm text-[var(--muted)]">
                One link per audience, each with its own settings and its own stats. Labels are private
                to you — recipients never see them.
              </div>
            </div>
            {canManage ? (
              <button
                type="button"
                onClick={() => managerRef.current?.openCreate()}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 text-[13px] font-semibold text-[var(--primary-fg)] shadow-sm transition-colors hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)]"
              >
                <PlusIcon className="h-4 w-4" aria-hidden="true" />
                New link
              </button>
            ) : null}
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
