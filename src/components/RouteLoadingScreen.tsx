"use client";

import { LOADING_OVERLAY_SHOW_TEXT_DEFAULT, LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX } from "@/lib/loadingOverlay";

/**
 * Full-screen route loading state that mirrors the doc-page navigation overlay
 * (`showSwitchingOverlay` in `SwitchingOverlay.tsx`): same ground, same 28px ring spinner,
 * same optional title. Use from App Router `loading.tsx` files so first loads and client-side
 * navigations show the exact animation users already know from opening a document.
 *
 * Keep the visuals in sync with the overlay markup in `SwitchingOverlay.tsx`.
 */
export default function RouteLoadingScreen({
  title,
  showTitle = LOADING_OVERLAY_SHOW_TEXT_DEFAULT,
  /** Force the dark ground used by public pages (`/s/:shareId`), regardless of the user's theme. */
  dark = false,
}: {
  title?: string;
  showTitle?: boolean;
  dark?: boolean;
}) {
  const label = showTitle && title ? title : "";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label || "Loading"}
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{
        background: dark ? "#0b0b0c" : "var(--bg, #0b0b0c)",
        color: dark ? "#e7e7ea" : "var(--fg, #e7e7ea)",
      }}
    >
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ gap: `${LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX}px` }}
      >
        {label ? (
          <div className="text-[17px] font-semibold tracking-[-0.01em] opacity-80">{label}</div>
        ) : null}
        <div
          aria-hidden="true"
          className="h-7 w-7 opacity-85 motion-safe:animate-[ldwsSpin_0.9s_linear_infinite]"
        >
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false" className="block h-full w-full">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path fill="currentColor" opacity="0.75" d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3z" />
          </svg>
        </div>
      </div>
    </div>
  );
}
