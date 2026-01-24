/**
 * SpinnerLoader
 *
 * Centered rotating spinner, optionally with a title above it (theme-aware via `currentColor`).
 */
"use client";

import Spinner from "@/components/ui/Spinner";
import { LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX } from "@/lib/loadingOverlay";

export type SpinnerLoaderProps = {
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
   * Tailwind className for the stack container.
   */
  stackClassName?: string;
  /**
   * Tailwind className for the spinner.
   */
  spinnerClassName?: string;
};

export default function SpinnerLoader({ title, className, stackClassName, spinnerClassName }: SpinnerLoaderProps) {
  const outer = className ?? "grid min-h-[100svh] place-items-center px-6";
  const stack = stackClassName ?? "flex flex-col items-center justify-center text-center";
  const showTitle = typeof title === "string" && title.trim().length > 0;

  return (
    <div className={outer}>
      <div className={stack} style={{ gap: LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX }}>
        {showTitle ? <div className="text-[17px] font-semibold tracking-[-0.01em] opacity-80">{title}</div> : null}
        <Spinner className={spinnerClassName ?? "h-7 w-7 text-[var(--fg)] opacity-90"} label={null} />
      </div>
    </div>
  );
}

