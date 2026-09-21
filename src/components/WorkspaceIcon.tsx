"use client";

import { cn } from "@/lib/cn";

/**
 * A workspace's uploaded icon: a white logo on a black disc.
 *
 * Owners are asked for a white (or light) logo on a transparent background, and the disc is black in
 * both themes, so one upload reads the same everywhere. The logo is contained, not cropped — a
 * `object-cover` crop used to shave the edges off square logos in the header pill.
 *
 * **Round, and the shape belongs to this component.** It was a rounded square, which is fine on the
 * dark theme where a black tile sits on a near-black ground and barely registers. In light mode the
 * same tile is a hard black square punched into a pale sidebar: the heaviest object on screen, and
 * next to nothing else that is square and black. A disc carries the same logo on the same black
 * without the corners, reads as an identity mark rather than a UI chip, and is about a fifth less
 * ink at the same diameter.
 *
 * Callers pass size only. Radius is not theirs to set: `cn()` concatenates rather than resolving
 * Tailwind conflicts, so a caller's `rounded-lg` and this file's `rounded-full` would both land in
 * the class list and the winner would be whichever Tailwind happened to emit later — a coin toss
 * that looks like a bug in one place and not another.
 *
 * Without an uploaded icon the caller's fallback (initials) renders on the neutral panel colour, in
 * the same disc.
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
  /** Size only, e.g. `h-9 w-9`. The disc shape is owned here — see the note above. */
  className: string;
  /** Tone and type size of the fallback disc; replaces the default neutral tone when given. */
  fallbackClassName?: string;
  onError?: () => void;
}) {
  if (avatarUrl) {
    return (
      <span
        className={cn("relative block shrink-0 overflow-hidden rounded-full bg-black", className)}
        aria-hidden="true"
      >
        {/*
          14% inset, up from the 6% the square used.
          A square logo only fits inside a circle if it sits within the inscribed square, which is
          1/√2 ≈ 70.7% of the diameter — so anything wider than that gets its corners clipped by the
          curve. 72% is that bound, and `object-contain` means a logo that is wider than it is tall
          is limited by width and still looks the same size as it did before.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={avatarUrl} alt="" className="absolute left-[14%] top-[14%] h-[72%] w-[72%] object-contain" onError={onError} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold",
        className,
        fallbackClassName ?? "bg-[var(--panel-hover)] text-[var(--fg)]",
      )}
      aria-hidden="true"
    >
      {fallback}
    </span>
  );
}
