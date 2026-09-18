/**
 * SubPageHeader — the header band for a resource's sub-pages (a project's or a document's Links
 * and Metrics pages, and one share link's metrics).
 *
 * It is `AppPageHeader` with a breadcrumb where the description goes: the same gutter, the same
 * `pt-6/pb-5`, the same `h-8` title row, the same `text-lg` title. That is the whole point —
 * walking from a project into its metrics used to change the band's height and the title's
 * baseline, so the icons and the heading hopped a few pixels on every navigation. Now nothing
 * moves but the words.
 *
 * What the sub-pages add on the left is the `ScopeTile`: the filled glyph that says *what you are
 * inside*, since a project's metrics page and a document's metrics page are otherwise the same
 * page. It is sized to the title row (32px) so the band keeps `AppPageHeader`'s height exactly.
 *
 * There is no back arrow. The breadcrumb's first crumb is the way back, and it sits where the
 * parent page's own icon sits — an arrow in front of the tile would push the title off the line it
 * shares with every other page's title, which is the thing this component exists to prevent.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import ScopeTile, { type ScopeKind } from "@/components/ScopeTile";

/** One step of the breadcrumb. The last one is the current page and never links. */
export type Crumb = { label: string; href?: string };

export default function SubPageHeader({
  kind,
  parent,
  title,
  titleHref,
  crumbs,
  badge,
  actions,
}: {
  kind: ScopeKind;
  /** For a link tile: the thing the link points at, badged onto the tile. */
  parent?: Exclude<ScopeKind, "link">;
  /** The resource's own name — the project, the document, or the link's address. */
  title: ReactNode;
  /** Where the title points, when it points anywhere (usually the resource's own page). */
  titleHref?: string;
  crumbs: Crumb[];
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={`shrink-0 border-b border-[var(--border)] bg-[var(--panel)] ${APP_PAGE_GUTTER} pb-5 pt-6`}>
      <div className="flex h-8 items-center justify-between gap-x-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <ScopeTile kind={kind} parent={parent} size="sm" />
          {titleHref ? (
            <Link
              href={titleHref}
              className="min-w-0 truncate text-lg font-semibold tracking-tight text-[var(--fg)] hover:underline underline-offset-4"
            >
              {title}
            </Link>
          ) : (
            <h1 className="truncate text-lg font-semibold tracking-tight text-[var(--fg)]">{title}</h1>
          )}
          {badge}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>

      {/* Exactly where `AppPageHeader` puts its description, so the band is the same height. */}
      <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[13px] leading-5 text-[var(--muted-2)]">
        {crumbs.map((crumb, i) => (
          <span key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-2">
            {i > 0 ? (
              <span aria-hidden="true" className="text-[var(--muted-2)]">
                ›
              </span>
            ) : null}
            {crumb.href ? (
              <Link href={crumb.href} className="truncate hover:text-[var(--fg)] hover:underline underline-offset-4">
                {crumb.label}
              </Link>
            ) : (
              <span className="max-w-[320px] truncate font-medium text-[var(--fg)]">{crumb.label}</span>
            )}
          </span>
        ))}
      </div>
    </header>
  );
}

/**
 * The bordered icon button used for the actions on the right of these bands — the same shape and
 * size as the project header's Links and Metrics buttons, so the pair does not move or change
 * weight when you navigate between the two pages. `active` marks the page you are already on.
 */
export function SubPageAction({
  href,
  label,
  active,
  children,
}: {
  href: string;
  label: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={[
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
        active
          ? "border-[var(--border)] bg-[var(--panel-hover)] text-[var(--fg)]"
          : "border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}
