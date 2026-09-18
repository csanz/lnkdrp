/**
 * Client component for the owner project links page.
 * Route: `/project/:projectId/links`
 *
 * The project page's side panel only summarises the links; this page is where they are managed.
 * Deliberately the same shell as `/doc/:docId/links` — the same back arrow, the same breadcrumb
 * shape, the same Metrics and New link buttons, the same intro, and the same `LinksManager` table
 * underneath. The two shells are separate files rather than one parameterised component because
 * they differ only in the title fetch and three nouns, and a shared shell would have to carry a
 * scope object through JSX that is already only a hundred lines long; the table, which is where
 * the behaviour lives, is genuinely shared.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ChartBarIcon, LinkIcon, PlusIcon } from "@heroicons/react/24/outline";

import LinksManager, { type LinksManagerHandle } from "@/components/links/LinksManager";
import ScopeTile from "@/components/ScopeTile";
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
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-4 sm:px-6">
        <Link
          href={`/project/${encodeURIComponent(projectId)}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Back to project"
          title="Back to project"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>

        {/* The tile says what you are inside; the "Links" heading below says what this page shows. */}
        <ScopeTile kind="project" />

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--fg)]">{projectName || "Project"}</div>
          <div className="mt-0.5 flex items-center gap-2 whitespace-nowrap text-xs text-[var(--muted)]">
            <Link href={`/project/${encodeURIComponent(projectId)}`} className="hover:underline underline-offset-4">
              Project
            </Link>
            <span aria-hidden="true">›</span>
            <span className="font-medium text-[var(--fg)]">Links</span>
          </div>
        </div>

        {/* Every row's own "Analytics" button scopes to that one link; this is the way out of the
            table to the master metrics page that sums across all of them. */}
        <Link
          href={`/project/${encodeURIComponent(projectId)}/metrics`}
          aria-label="Metrics"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
        >
          <ChartBarIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
          <span className="hidden sm:inline">Metrics</span>
        </Link>

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

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="w-full px-4 py-6 sm:px-6">
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
