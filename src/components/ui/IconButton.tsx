/**
 * IconButton — a small, consistent icon-only button primitive.
 *
 * Designed to replace ad-hoc Tailwind class strings for common "pencil/close/menu" actions.
 */
"use client";

type Variant = "outline" | "ghost";
type Size = "sm" | "md";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children" | "aria-label"> & {
  ariaLabel: string;
  variant?: Variant;
  size?: Size;
  children: React.ReactNode;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function IconButton({
  ariaLabel,
  variant = "outline",
  size = "md",
  className,
  children,
  ...rest
}: Props) {
  const base = "inline-flex items-center justify-center focus-visible:outline-none focus-visible:ring-2";
  const padding = size === "sm" ? "p-1.5" : "p-2";
  const shape = "rounded-lg";
  const palette =
    variant === "ghost"
      ? "bg-transparent text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:ring-[var(--ring)]"
      : "border border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:ring-[var(--ring)]";
  const disabledStyle = "disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={rest.disabled}
      className={cx(base, shape, padding, palette, disabledStyle, className)}
      {...rest}
    >
      {children}
    </button>
  );
}


