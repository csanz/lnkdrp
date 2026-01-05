import { QuestionMarkCircleIcon } from "@heroicons/react/24/outline";

/**
 * Small help tooltip shown on hover/focus.
 *
 * Usage:
 * - Place next to section headings or labels.
 * - The tooltip is non-interactive (pointer-events none) by design.
 */
export default function HelpTooltip({
  label,
  body,
  align = "right",
  widthClassName = "w-[260px]",
}: {
  label: string;
  body: string;
  align?: "left" | "right";
  widthClassName?: string;
}) {
  const alignClass = align === "left" ? "left-0" : "right-0";
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-md p-1 text-[var(--muted-2)] hover:text-[var(--fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border)]"
        aria-label={label}
      >
        <QuestionMarkCircleIcon className="h-5 w-5" aria-hidden="true" />
      </button>
      <span
        className={[
          "pointer-events-none absolute top-9 z-50 hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-[12px] leading-5 text-[var(--muted-2)] shadow-lg",
          widthClassName,
          alignClass,
          "group-hover:block group-focus-within:block",
        ].join(" ")}
      >
        {body}
      </span>
    </span>
  );
}


