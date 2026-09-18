/**
 * ScopeTile — the glyph in a sub-page header that says *what you are inside*: a project, a
 * document, or one share link.
 *
 * The metrics and links sub-pages of a project and of a document are deliberately identical in
 * structure, so the only thing separating "the data room's numbers" from "this deck's numbers" was
 * a muted glyph the same weight as every other icon on the page, plus one word in the breadcrumb.
 * This tile is filled instead of muted so it reads at a glance, in both themes, without inventing a
 * colour code (amber already means starred, emerald already means live).
 *
 * The rule it follows, used by every header that renders it: **the tile is the thing you are
 * inside; the heading is what the page shows.** A project's links page shows a folder tile over a
 * "Links" heading; one link's metrics page shows a link tile over that link's address.
 */
import { DocumentTextIcon, FolderIcon, LinkIcon } from "@heroicons/react/24/outline";

export type ScopeKind = "project" | "doc" | "link";

const ICON = {
  project: FolderIcon,
  doc: DocumentTextIcon,
  link: LinkIcon,
} as const;

const LABEL: Record<ScopeKind, string> = {
  project: "Project",
  doc: "Document",
  link: "Share link",
};

/**
 * The filled scope glyph for a sub-page header.
 *
 * `parent` is what a link points at. A link to a data room and a link to a single document open
 * the same page with the same tiles — the URL path (`/p/` vs `/s/`) and one breadcrumb word were
 * the only difference — so a link tile carries a small badge of the thing behind it.
 */
export default function ScopeTile({
  kind,
  parent,
  className,
}: {
  kind: ScopeKind;
  parent?: Exclude<ScopeKind, "link">;
  className?: string;
}) {
  const Icon = ICON[kind];
  const BadgeIcon = kind === "link" && parent ? ICON[parent] : null;
  const label = kind === "link" && parent ? `${LABEL.link} to a ${parent === "project" ? "project" : "document"}` : LABEL[kind];
  return (
    <div className={["relative shrink-0", className ?? ""].join(" ")} role="img" aria-label={label} title={label}>
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--fg)] text-[var(--bg)]">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden="true" />
      </div>
      {BadgeIcon ? (
        <span className="absolute -bottom-1 -right-1 inline-flex h-[17px] w-[17px] items-center justify-center rounded-md bg-[var(--panel)] text-[var(--fg)] ring-1 ring-[var(--border)]">
          <BadgeIcon className="h-[11px] w-[11px]" strokeWidth={2} aria-hidden="true" />
        </span>
      ) : null}
    </div>
  );
}
