/**
 * The coloured dot that stands for a tag.
 *
 * Dots rather than filled pills (2026-09-18 decision, docs/prds/lnkdrp-tags.md): a sidebar row can
 * carry three of them without becoming a paint chart, and the same mark works at 6px next to a
 * project name and at 8px inside a chip. Colour comes from the palette by key so a shade can be
 * retuned in one file.
 */
"use client";

import { asTagColorKey, TAG_COLORS } from "@/lib/tags/palette";

export default function TagDot({
  color,
  size = 8,
  className,
}: {
  color: unknown;
  /** 6px in a dense list, 8px in a chip. */
  size?: number;
  className?: string;
}) {
  const key = asTagColorKey(color);
  return (
    <span
      aria-hidden="true"
      className={["inline-block shrink-0 rounded-full", className ?? ""].join(" ")}
      style={{
        width: size,
        height: size,
        // One variable, two themes: `--tag-dot` is defined per theme in globals.css so a dot keeps
        // its contrast on a dark sidebar and on a white panel without a second component.
        backgroundColor: `var(--tag-${key})`,
      }}
    />
  );
}

/** The palette as CSS variables, for the one place that needs them all at once (the picker). */
export const TAG_COLOR_HEX = TAG_COLORS;
