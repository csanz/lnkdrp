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

      {/* Full width, like Metrics, Connect and Requests. A tag row is a name, a count, six colour
          swatches and two actions — it fits in a column half the page wide, and capping the page at
          max-w-4xl left two thirds of a wide screen empty while the list itself scrolled. */}
      <div className={`min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`}>
        <TagsManager />
      </div>
    </div>
  );
}
