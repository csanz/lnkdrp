/**
 * AdminSection — the one shell every block below a page header uses.
 *
 * A page that carries more than one thing (credits, emails, a workspace hub) was growing
 * a new chrome treatment per block: some in a panel with a tinted header band, some bare
 * tiles, some a plain small heading with a caption underneath. One shape ends that:
 * heading, one line of prose, optional controls on the right, then the block.
 *
 * The caption is where a caveat goes. A muted paragraph dangling under a table is a
 * footnote nobody attaches to anything; the same sentence in the caption is read first.
 */
"use client";

import { cn } from "@/lib/cn";
import { ADMIN_SECTION_DESC, ADMIN_SECTION_GAP, ADMIN_SECTION_TITLE } from "@/lib/admin/ui";

export type AdminSectionProps = {
  /** What this block is: "Balances", "Credit ledger", "What we send". */
  title: string;
  /** One sentence: what is in it, what it is capped at, what it excludes. */
  description?: React.ReactNode;
  /** Controls scoped to this block only — lighter than the page's filter band. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Drop the standing gap above when this is the first block on the page. */
  first?: boolean;
  className?: string;
};

/** A titled block on a multi-section admin page. */
export default function AdminSection({
  title,
  description,
  actions,
  children,
  first = false,
  className,
}: AdminSectionProps) {
  return (
    <section className={cn(first ? "mt-4" : ADMIN_SECTION_GAP, className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className={ADMIN_SECTION_TITLE}>{title}</h2>
          {description ? <p className={ADMIN_SECTION_DESC}>{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
