/**
 * Client component for `/tags`.
 *
 * The same header band as Metrics, Activity and Upload, with the workspace's tags under it.
 */
"use client";

import { TagIcon } from "@heroicons/react/24/outline";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import TagsManager from "@/components/tags/TagsManager";

export default function TagsPageClient() {
  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={TagIcon}
        title="Tags"
        description="Every tag in this workspace, and what carries it. Renaming or merging changes it everywhere."
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`w-full max-w-4xl py-6 ${APP_PAGE_GUTTER}`}>
          <TagsManager />
        </div>
      </div>
    </div>
  );
}
