"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Presentational workspace pill used across app + dashboard headers.
 *
 * `ActiveWorkspacePill` owns data fetching; this component owns consistent styling.
 */
export default function WorkspacePill({
  href,
  title,
  ariaLabel,
  className,
  maxWidthClassName,
  textClassName,
  name,
  avatarUrl,
  avatarFallbackText,
  avatarErrored,
  onAvatarError,
  showBadge,
  badgeText,
}: {
  href?: string;
  title: string;
  ariaLabel: string;
  className?: string;
  maxWidthClassName?: string;
  textClassName?: string;
  name: string;
  avatarUrl: string | null;
  avatarFallbackText: string;
  avatarErrored: boolean;
  onAvatarError: () => void;
  showBadge: boolean;
  badgeText: string;
}) {
  const wrapperClassNameFinal = cn(
    [
      "inline-flex min-w-0 items-stretch overflow-hidden rounded-2xl",
      "border border-[var(--border)] bg-[var(--panel)] font-semibold text-[var(--fg)]",
      "transition-colors hover:bg-[var(--panel-hover)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 dark:focus-visible:ring-white/10",
      "no-underline hover:no-underline",
      "dark:border-[color-mix(in_srgb,var(--border)_30%,transparent)]",
    ].join(" "),
    maxWidthClassName,
    textClassName ?? "text-[13px]",
    className,
  );

  const content = (
    <>
      <div className="flex min-w-0 items-center px-[10px] py-[6px]">
        <span
          className="mr-1.5 grid h-[15px] w-[15px] shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--panel-hover)] text-[8px] font-semibold text-[var(--fg)]"
          aria-hidden="true"
        >
          {avatarUrl && !avatarErrored ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              className="h-[15px] w-[15px] object-cover"
              onError={onAvatarError}
            />
          ) : (
            <span aria-hidden="true">{avatarFallbackText}</span>
          )}
        </span>
        <span className="min-w-0 truncate">{name}</span>
      </div>

      {showBadge ? (
        <div
          className="inline-flex shrink-0 items-center border-l border-[var(--border)] bg-[var(--panel-2)] px-3 py-[6px] text-[9px] font-medium tracking-[0.07em] text-[var(--muted-2)] dark:border-[color-mix(in_srgb,var(--border)_30%,transparent)] dark:bg-[color-mix(in_srgb,var(--panel)_85%,black)] dark:text-[color-mix(in_srgb,var(--fg)_70%,var(--bg))]"
          aria-label={`${badgeText} plan`}
          title={`${badgeText} plan`}
        >
          {badgeText}
        </div>
      ) : null}
    </>
  );

  if (!href) {
    return (
      <div className={wrapperClassNameFinal} title={title} aria-label={ariaLabel}>
        {content}
      </div>
    );
  }

  return (
    <Link href={href} className={wrapperClassNameFinal} title={title} aria-label={ariaLabel}>
      {content}
    </Link>
  );
}

