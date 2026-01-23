/**
 * Alert — small inline message box for errors/info.
 *
 * Intentionally minimal (no dependencies) so it can be used broadly across the app.
 */
"use client";

type AlertVariant = "error" | "info";

type Props = {
  variant?: AlertVariant;
  className?: string;
  children: React.ReactNode;
  /**
   * Override default ARIA role. By default:
   * - error: role="alert"
   * - info: role="status"
   */
  role?: "alert" | "status";
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Inline alert box for info/error messaging.
 *
 * Exists to provide consistent styling + sensible ARIA defaults (`alert` for errors, `status` for info).
 * Side effects: none; renders a semantic `<div>` with the chosen role.
 */
export default function Alert({ variant = "info", className, children, role }: Props) {
  const base = "rounded-xl border px-4 py-3";
  const v =
    variant === "error"
      ? "border-red-500/20 bg-red-500/10 text-red-700"
      : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted-2)]";

  const computedRole = role ?? (variant === "error" ? "alert" : "status");

  return (
    <div role={computedRole} className={cx(base, v, className)}>
      {children}
    </div>
  );
}


