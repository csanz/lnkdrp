/**
 * The tags on a sidebar row, as dots.
 *
 * Three at most — a row is 28px of space already carrying an icon, a name and a count, and a
 * fourth dot turns a hint into a bar chart. The title says all of them, so hovering answers "which
 * ones" without spending width on it.
 */
"use client";

import TagDot from "@/components/tags/TagDot";
import type { RowTag } from "@/lib/client/useTargetTags";

const MAX_DOTS = 3;

export default function TagDots({ tags, className }: { tags: RowTag[] | undefined; className?: string }) {
  if (!tags || !tags.length) return null;
  const shown = tags.slice(0, MAX_DOTS);
  return (
    <span
      className={["inline-flex shrink-0 items-center gap-1", className ?? ""].join(" ")}
      title={tags.map((t) => t.name).join(" · ")}
    >
      {shown.map((tag) => (
        <TagDot key={tag.id} color={tag.color} size={6} />
      ))}
    </span>
  );
}
