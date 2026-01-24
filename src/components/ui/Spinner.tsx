/**
 * Spinner
 *
 * Minimal rotating circle spinner (theme-aware via `currentColor`).
 */

export type SpinnerProps = {
  /**
   * Tailwind className applied to the `<svg>`.
   * Defaults to `h-4 w-4`.
   */
  className?: string;
  /**
   * Accessible label (set to null to make it purely decorative).
   */
  label?: string | null;
};

/**
 * A tiny rotating spinner using SVG + `animate-spin`.
 */
export default function Spinner({ className, label = "Loading" }: SpinnerProps) {
  const ariaProps =
    label === null
      ? ({ "aria-hidden": true } as const)
      : ({ role: "status", "aria-label": label } as const);

  return (
    <svg viewBox="0 0 24 24" className={["animate-spin", className ?? "h-4 w-4"].join(" ")} {...ariaProps}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path fill="currentColor" className="opacity-75" d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3z" />
    </svg>
  );
}

