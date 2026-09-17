"use client";

import { cn } from "@/lib/cn";

/**
 * A workspace's uploaded icon, always on a black tile.
 *
 * Owners are asked for a white (or light) logo on a transparent background, and the tile is black in
 * both themes, so one upload reads the same everywhere. The logo is contained, not cropped: a
 * rounded-full `object-cover` crop at 15px used to shave the edges off square logos in the header pill.
 *
 * Without an uploaded icon the caller's fallback (initials) renders on the neutral panel colour.
 */
export default function WorkspaceIcon({
  avatarUrl,
  fallback,
  className,
  fallbackClassName,
  onError,
}: {
  avatarUrl: string | null | undefined;
  fallback: React.ReactNode;
  /** Size and radius, e.g. `h-9 w-9 rounded-lg`. */
  className: string;
  /** Tone and type size of the fallback tile; replaces the default neutral tone when given. */
  fallbackClassName?: string;
  onError?: () => void;
}) {
  if (avatarUrl) {
    return (
      <span className={cn("relative block shrink-0 overflow-hidden bg-black", className)} aria-hidden="true">
        {/* Absolute percentages against the tile's fixed size: `h-full` inside a grid cell has no definite
            height, so a large image rendered at its natural height and only its empty middle showed. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatarUrl} alt="" className="absolute left-[12%] top-[12%] h-[76%] w-[76%] object-contain" onError={onError} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden font-semibold",
        className,
        fallbackClassName ?? "bg-[var(--panel-hover)] text-[var(--fg)]",
      )}
      aria-hidden="true"
    >
      {fallback}
    </span>
  );
}
