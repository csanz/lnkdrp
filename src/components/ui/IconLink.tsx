/**
 * IconLink — icon-only Next.js Link primitive with consistent styling.
 *
 * Use when you need link semantics (e.g. cmd/ctrl-click, open in new tab) but want
 * the same visual language as IconButton.
 */
"use client";

import Link, { type LinkProps } from "next/link";

type Variant = "outline" | "ghost";
type Size = "sm" | "md";

type Props = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children" | "aria-label"> &
  Pick<LinkProps, "href" | "prefetch" | "replace" | "scroll"> & {
    ariaLabel: string;
    variant?: Variant;
    size?: Size;
    className?: string;
    children: React.ReactNode;
  };

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function IconLink({
  ariaLabel,
  variant = "outline",
  size = "md",
  className,
  children,
  href,
  prefetch,
  replace,
  scroll,
  ...rest
}: Props) {
  const base = "inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2";
  const padding = size === "sm" ? "p-1.5" : "p-2";
  const shape = "rounded-lg";
  const palette =
    variant === "ghost"
      ? "bg-transparent text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:ring-[var(--ring)]"
      : "border border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:ring-[var(--ring)]";

  return (
    <Link
      href={href}
      prefetch={prefetch}
      replace={replace}
      scroll={scroll}
      aria-label={ariaLabel}
      className={cx(base, shape, padding, palette, className)}
      {...rest}
    >
      {children}
    </Link>
  );
}


