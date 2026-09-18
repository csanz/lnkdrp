/**
 * AdminPageHeader — the same header shape on every admin page.
 *
 * Title (one line), one-line description, optional right-side page actions. Nothing
 * else lives here: filters and pagination belong to `AdminFilterBar` below it.
 */
import { cn } from "@/lib/cn";

export type AdminPageHeaderProps = {
  /** Page title. Plain words, no "Admin / Data /" breadcrumb — the sidebar says where you are. */
  title: string;
  /** One line telling an admin what this list is. Required in spirit; optional in types. */
  description?: React.ReactNode;
  /** Page-level actions (Refresh, Export, links out). Row actions never go here. */
  actions?: React.ReactNode;
  className?: string;
};

/** The page header every admin route starts with: title, one-line description, actions. */
export default function AdminPageHeader({ title, description, actions, className }: AdminPageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="truncate text-[19px] font-semibold leading-7 tracking-tight text-[var(--fg)]">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-[13px] leading-5 text-[var(--muted-2)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
