/**
 * Minimal shared "Not available" helper.
 *
 * IMPORTANT: Keep the default label exactly "Not available" (user-visible string).
 */
export default function NotAvailable({
  className,
  label = "Not available",
}: {
  className?: string;
  label?: string;
}) {
  return <span className={className ?? ""}>{label}</span>;
}


