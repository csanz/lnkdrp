/**
 * Client shell for a project reader's page: the project's own header band, then the reader.
 */
"use client";

import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader from "@/components/SubPageHeader";
import ProjectIdentityRow from "@/components/project/ProjectIdentityRow";
import ProjectHeaderActions from "@/components/project/ProjectHeaderActions";
import ViewerProfile from "@/components/metrics/ViewerProfile";

export default function ViewerPageClient({ projectId, viewerKey }: { projectId: string; viewerKey: string }) {
  const base = `/project/${encodeURIComponent(projectId)}`;
  return (
    <div className="flex h-full flex-col">
      <SubPageHeader
        kind="project"
        hideTile
        title={<ProjectIdentityRow projectId={projectId} />}
        crumbs={[
          { label: "Project", href: base },
          { label: "Metrics", href: `${base}/metrics` },
          { label: "Reader" },
        ]}
        actions={<ProjectHeaderActions projectSlug={projectId} current="metrics" />}
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`w-full max-w-5xl py-6 ${APP_PAGE_GUTTER}`}>
          <ViewerProfile scopeKind="project" scopeId={projectId} routeKey={viewerKey} />
        </div>
      </div>
    </div>
  );
}
