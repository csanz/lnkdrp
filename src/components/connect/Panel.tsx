import type { ReactNode } from "react";

/**
 * A titled section on the Connect page: the same bordered panel on `--panel` the activity feed
 * uses, with a small heading row (title, optional caption on the right) and padded content.
 */
export default function Panel({
  title,
  caption,
  action,
  children,
  id,
}: {
  title: string;
  caption?: string;
  /** Rendered at the right of the heading row, e.g. a "Create key" button. */
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--border)] px-5 py-3.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 id={id ? `${id}-title` : undefined} className="text-[14px] font-semibold text-[var(--fg)]">
            {title}
          </h2>
          {caption ? <span className="text-[11px] font-medium tracking-wide text-[var(--muted-2)]">{caption}</span> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}
