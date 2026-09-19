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
 */
"use client";

import Link from "next/link";
import { FolderIcon, InboxArrowDownIcon } from "@heroicons/react/24/outline";

import TagsRow from "@/components/tags/TagsRow";

export default function ProjectIdentityRow({
  projectId,
  name,
  isRequest = false,
  canManageTags = true,
}: {
  projectId: string;
  name: string;
  isRequest?: boolean;
  canManageTags?: boolean;
}) {
  const Icon = isRequest ? InboxArrowDownIcon : FolderIcon;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
      <Link
        href={`/project/${encodeURIComponent(projectId)}`}
        className="min-w-0 truncate text-lg font-semibold tracking-tight text-[var(--fg)] hover:underline underline-offset-4"
      >
        {name || "Project"}
      </Link>
      {isRequest ? (
        <span className="shrink-0 rounded-full bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]">
          Request link
        </span>
      ) : null}
      <TagsRow targetKind="project" targetId={projectId} canManage={canManageTags} variant="header" />
    </span>
  );
}
