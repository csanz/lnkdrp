/**
 * Button — small reusable button primitive (no deps).
 *
 * Goal: replace repeated Tailwind class strings for common buttons across the app/admin.
 */
"use client";

type Variant = "outline" | "secondary" | "solid" | "danger" | "ghost";
type Size = "sm" | "md";

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: Variant;
  size?: Size;
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Styled button primitive used across app/admin UIs.
 *
 * Exists to keep button variants/sizes consistent without repeating Tailwind strings.
 * Side effects: none; always renders a `<button type="button">` by default.
 */
export default function Button({ variant = "outline", size = "md", className, disabled, ...rest }: ButtonProps) {
  const base =
    "inline-flex items-center justify-center font-semibold transition focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60";
  const pad = size === "sm" ? "px-2.5 py-1.5 text-[12px] rounded-lg" : "px-3 py-2 text-sm rounded-xl";

  const v =
    variant === "solid"
      ? "bg-[var(--fg)] text-[var(--bg)] hover:opacity-90 focus-visible:ring-[var(--ring)]"
      : variant === "danger"
        ? "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500/40"
        : variant === "secondary"
          ? "border border-[var(--border)] bg-[var(--panel-2)] text-[var(--fg)] hover:bg-[var(--panel-hover)] focus-visible:ring-[var(--ring)]"
        : variant === "ghost"
          ? "bg-transparent text-[var(--fg)] hover:bg-[var(--panel-hover)] focus-visible:ring-[var(--ring)]"
          : "border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] hover:bg-[var(--panel-hover)] focus-visible:ring-[var(--ring)]";

  return <button type="button" disabled={disabled} className={cx(base, pad, v, className)} {...rest} />;
}


