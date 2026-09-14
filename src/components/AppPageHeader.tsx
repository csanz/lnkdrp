/**
 * AppPageHeader — the header band shared by the top-level app pages (Search, Upload, Activity,
 * Agents, Received), so the icon, title, description and padding sit in exactly the same place on
 * each. Page bodies below it use the same horizontal padding (`APP_PAGE_GUTTER`).
 *
 * Document sub-pages (history, metrics, links) keep their back-arrow headers.
 */
import type { ComponentType, ReactNode, SVGProps } from "react";

/** Horizontal padding for the header band and the page body under it. */
export const APP_PAGE_GUTTER = "px-5 sm:px-8";

export default function AppPageHeader({
  icon: Icon,
  title,
  description,
  badge,
  actions,
  children,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: ReactNode;
  description?: ReactNode;
  /** Small inline element after the title (e.g. a "Live" pill). */
  badge?: ReactNode;
  /** Right-aligned element on the title row (e.g. a status pill or plan pill). */
  actions?: ReactNode;
  /** Controls under the description (filters, a search field, a steps rail). */
  children?: ReactNode;
}) {
  return (
    <header className={`shrink-0 border-b border-[var(--border)] bg-[var(--panel)] ${APP_PAGE_GUTTER} pb-5 pt-6`}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
          <h1 className="truncate text-lg font-semibold tracking-tight text-[var(--fg)]">{title}</h1>
          {badge}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {description ? <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-[var(--muted-2)]">{description}</p> : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </header>
  );
}
