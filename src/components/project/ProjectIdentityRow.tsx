/**
 * Who this project is, for the header of one of its sub-pages.
 *
 * The counterpart to `DocIdentityRow`, and for the same reason: the project page's title row is a
 * folder glyph, the name and its tags, and its Links and Metrics pages replaced all three with a
 * filled tile and the word "Project". Walking into a project's numbers should read as going
 * deeper, not as arriving somewhere else.
 *
 * The glyph is the same size and colour `AppPageHeader` draws for the project page, so the name
 * lands on the same pixel either side of a navigation.
 *
 * It also fetches its own name, the way `DocIdentityRow` always has. Purely presentational, it was
 * at the mercy of whatever the parent page happened to be fetching — and on the metrics page that
 * is the whole analytics aggregation, so the name arrived hundreds of milliseconds after everything
 * else in the band. A caller that already knows the name still wins; this is the floor, not the
 * authority.
 */
"use client";

import { useEffect } from "react";
import { FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";

import TagsRow from "@/components/tags/TagsRow";
import { EntityHeaderName } from "@/components/HeaderIdentity";
import { rememberEntityTitle } from "@/lib/client/entityTitles";
import { useEntityIdentity } from "@/lib/client/entityIdentity";

/** Render the project's identity row: glyph, name, request badge and tags. */
export default function ProjectIdentityRow({
  projectId,
  name,
  isRequest,
  canManageTags = true,
}: {
  projectId: string;
  /** A name the page already has. Optional: without one the row finds it itself. */
  name?: string;
  /**
   * Whether this is a request repository, when the caller knows.
   *
   * Omitted, the row uses its own identity read. None of the sub-pages passed it, so opening a
   * request project's Links or Metrics silently swapped its inbox glyph for a folder and dropped
   * the "Request link" badge — the header changing identity on exactly the navigation this row
   * exists to hold still.
   */
  isRequest?: boolean;
  canManageTags?: boolean;
}) {
  const { identity } = useEntityIdentity("project", projectId);
  const request = isRequest ?? identity?.isRequest ?? false;
  const Icon = request ? InboxArrowDownIcon : FolderIcon;

  useEffect(() => {
    const seed = name?.trim();
    if (seed) rememberEntityTitle("project", projectId, seed);
  }, [projectId, name]);

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
      {/* Never the literal word "Project": a placeholder shaped like a name is the flash this row
          exists to prevent. Unknown draws a skeleton — and only until the read settles, since a
          project that genuinely has no name still has to be called something. */}
      <EntityHeaderName kind="project" id={projectId} name={name} href={`/project/${encodeURIComponent(projectId)}`} />
      {request ? (
        <span className="shrink-0 rounded-full bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]">
          Request link
        </span>
      ) : null}
      <TagsRow targetKind="project" targetId={projectId} canManage={canManageTags} variant="header" />
    </span>
  );
}
