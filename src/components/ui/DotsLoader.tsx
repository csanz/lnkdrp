/**
 * DotsLoader
 *
 * Centered "Loading…" label + animated dots, using `currentColor` so it matches theme colors.
 */
"use client";

import { LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX } from "@/lib/loadingOverlay";

export type DotsLoaderProps = {
  /**
   * Optional title text. Set to `null` to hide.
   */
  title?: string | null;
  /**
   * Tailwind className for the outer container.
   * Default: full-screen centered.
   */
  className?: string;
  /**
   * Tailwind className for the stack gap between title and dots.
   * Default: `gap-6`.
   */
  stackClassName?: string;
};

function DotsSvg(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      width="160"
      height="24"
      viewBox="0 0 160 24"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Loading"
    >
      <title>Loading</title>

      {/* Dot 1 */}
      <circle cx="20" cy="12" r="3" fill="currentColor" opacity="0.3">
        <animate attributeName="r" values="3;6;3" dur="1.2s" repeatCount="indefinite" begin="0s" />
        <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin="0s" />
      </circle>

      {/* Dot 2 */}
      <circle cx="60" cy="12" r="3" fill="currentColor" opacity="0.3">
        <animate attributeName="r" values="3;6;3" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
        <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin="0.3s" />
      </circle>

      {/* Dot 3 */}
      <circle cx="100" cy="12" r="3" fill="currentColor" opacity="0.3">
        <animate attributeName="r" values="3;6;3" dur="1.2s" repeatCount="indefinite" begin="0.6s" />
        <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin="0.6s" />
      </circle>

      {/* Dot 4 */}
      <circle cx="140" cy="12" r="3" fill="currentColor" opacity="0.3">
        <animate attributeName="r" values="3;6;3" dur="1.2s" repeatCount="indefinite" begin="0.9s" />
        <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin="0.9s" />
      </circle>
    </svg>
  );
}

/**
 * Centered themed loading indicator (label + dots).
 */
export default function DotsLoader({ title, className, stackClassName }: DotsLoaderProps) {
  const outer = className ?? "grid min-h-[100svh] place-items-center px-6";
  const stack = stackClassName ?? "flex flex-col items-center justify-center text-center";
  const showTitle = typeof title === "string" && title.trim().length > 0;
  return (
    <div className={outer}>
      <div className={stack} style={{ gap: LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX }}>
        {showTitle ? <div className="text-[18px] font-bold tracking-[-0.01em]">{title}</div> : null}
        <DotsSvg className="block text-[var(--fg)] opacity-90" />
      </div>
    </div>
  );
}

