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
      {/* The actions sit beside the title *and* its description, centred against both, which is
          where the document page has always put them and the alignment every other page is judged
          against. Inside the title row they centred on that one line and sat 13px higher, so the
          same controls moved as you walked between a page and its sub-pages. `SubPageHeader` lays
          out identically. */}
      <div className="md:flex md:items-center md:justify-between md:gap-x-4">
        <div className="min-w-0 md:flex-1">
          {/* `h-8` from `sm` up, not `min-h-8`: a badge taller than the title used to grow this row,
              which moved the title off the line the sidebar logo sits on — the one horizontal rule
              every page shares. Anything taller than 32px centres inside it instead.
              Below `sm` the row is allowed to grow, because there the row also *wraps*
              (`flex-wrap`, dropped at `sm`) — a badge that wrapped to a second line inside a
              locked 32px box overlapped the title rather than sitting under it. The rule the fixed
              height protects is a desktop rule; on a phone the sidebar is a drawer and there is no
              shared line to hold. */}
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:h-8 sm:flex-nowrap">
            <div className="flex min-w-0 items-center gap-2.5">
              <Icon className="h-5 w-5 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
              <h1 className="truncate text-lg font-semibold tracking-tight text-[var(--fg)]">{title}</h1>
              {badge}
            </div>
            {/* Narrow screens keep them on the title line: there is no second column to sit beside. */}
            {actions ? <div className="shrink-0 md:hidden">{actions}</div> : null}
          </div>
          {description ? <p className="mt-1.5 max-w-3xl text-[13px] leading-5 text-[var(--muted-2)]">{description}</p> : null}
        </div>
        {actions ? <div className="hidden shrink-0 md:block">{actions}</div> : null}
      </div>
      {children ? <div className="mt-5">{children}</div> : null}
    </header>
  );
}
